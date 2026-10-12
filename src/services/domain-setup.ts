import { eq } from "drizzle-orm";
import { z } from "zod";
import { HttpError } from "../api/http";
import { findDomain } from "../api/finders";
import type { Db } from "../db/client";
import { sendingDomains, senders } from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { dkimWindowClosed, parseDnsRecords, registrableRoot } from "../lib/domain";
import { enforceRateLimit } from "../lib/rate-limit";
import { isDomainBlocked } from "./blocked-domains";
import { detectRegistrar } from "./dns-registrar";
import { publishToCloudflare } from "./dns-publish";
import { resolveRecords } from "./dns-resolve";
import { isDomainClaimed } from "./domain-ownership";
import { createDomainIdentity, ensureMailFrom, getDomainIdentity, restartDkim } from "./ses-identity";
import { BLOCKED_DOMAIN_MESSAGE } from "./shared-domain";

// Adding and re-checking a sending domain. One implementation, two front doors:
// the app's /api/domains routes and the MCP setup tools both call these, so the
// ban, ownership and SES steps cannot drift between them.

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

export const CreateDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(DOMAIN_RE, "Enter a valid domain like updates.example.com"),
  fromName: z.string().trim().min(1).max(100),
  fromEmail: z.email().toLowerCase(),
});
export type CreateDomainInput = z.infer<typeof CreateDomainSchema>;

export async function addSendingDomain(db: Db, accountId: string, input: CreateDomainInput) {
  const { domain, fromName, fromEmail } = input;
  if (!fromEmail.endsWith(`@${domain}`)) {
    throw new HttpError(400, "From email must use the sending domain");
  }

  // Domain ownership is GLOBAL, not per-tenant: one domain is one shared SES
  // identity, so letting a second account claim it would hand them a
  // "verified" row with no DNS proof, and the ability to send DKIM-signed mail
  // as the real owner. See services/domain-ownership.ts for the full reasoning.
  // The same 409 whether the holder is this account or another one: which
  // tenants use which domains isn't ours to leak.
  // A platform-wide ban is checked BEFORE ownership. Ownership only says who
  // holds the name right now; a ban says the name is done on Day3 regardless
  // of who is asking or whether anyone currently holds it. Without this, an
  // attacker whose account was paused could release the domain and re-add it
  // on a fresh org (services/blocked-domains.ts).
  if (await isDomainBlocked(db, domain)) {
    throw new HttpError(403, BLOCKED_DOMAIN_MESSAGE);
  }

  if (await isDomainClaimed(db, domain)) {
    throw new HttpError(409, "That domain is already added");
  }

  const id = newId("dom");
  const now = nowIso();
  try {
    await db.insert(sendingDomains).values({
      id,
      accountId,
      domain,
      fromName,
      fromEmail,
      provider: "ses",
      verificationStatus: "pending",
      dkimStatus: "pending",
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    throw new HttpError(409, "That domain is already added");
  }

  // Auto-create the domain's first sender from the From identity entered here, so
  // the campaign composer always has a sender to pick. The account's first sender
  // becomes its default. Best-effort: a duplicate address is harmless.
  const existingSender = await db.query.senders.findFirst({
    where: eq(senders.accountId, accountId),
  });
  await db
    .insert(senders)
    .values({
      id: newId("snd"),
      accountId,
      sendingDomainId: id,
      fromName,
      fromEmail,
      isDefault: !existingSender,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  // Headline feature: register the domain with SES (Easy DKIM) and store the
  // CNAME records to show the customer. Best-effort: if SES isn't configured or
  // errors, the domain stays "pending" and /check (or admin override) resolves it.
  const region = process.env.AWS_REGION;
  if (region) {
    try {
      const state = await createDomainIdentity(domain, region, process.env.SES_CONFIGURATION_SET);
      await db
        .update(sendingDomains)
        .set({
          providerIdentityId: domain,
          verificationStatus: state.verificationStatus,
          dkimStatus: state.dkimStatus,
          mailFromDomain: state.mailFromDomain,
          mailFromStatus: state.mailFromStatus,
          dnsRecordsJson: JSON.stringify(state.records),
          updatedAt: nowIso(),
        })
        .where(eq(sendingDomains.id, id));
    } catch (err) {
      console.error("[domains] SES CreateEmailIdentity failed:", err);
    }
  }

  return (await findDomain(db, accountId, id))!;
}

// Per-record live status via DoH (independent of SES) so the UI can show each
// record as "Found"/"Waiting". `requiredResolved` covers only the DKIM (verify)
// records; deliverability rows (Return-Path/DMARC) report their own status.
export function dnsFor(domain: { dnsRecordsJson: string | null }) {
  return resolveRecords(parseDnsRecords(domain.dnsRecordsJson));
}

// Re-check verification with SES (GetEmailIdentity). When VerifiedForSendingStatus
// is true the domain flips to "verified": SES's own status is authoritative. The
// admin override path remains the testing fallback.
export async function recheckSendingDomain(db: Db, accountId: string, domainId: string) {
  await enforceRateLimit(
    "domain_recheck",
    accountId,
    undefined,
    "Still checking. DNS can take a while to propagate. We're watching this automatically, so you don't have to keep refreshing.",
  );
  const row = await findDomain(db, accountId, domainId);
  if (!row) throw new HttpError(404, "Not found");

  const region = process.env.AWS_REGION;
  if (region && row.provider === "ses") {
    try {
      let state = await getDomainIdentity(row.domain, region);
      // Retrofit identities created before custom MAIL FROM existed. Guard on the
      // "not_started" sentinel so we don't issue a write on every poll.
      if (state.mailFromStatus === "not_started") {
        try {
          await ensureMailFrom(row.domain, region);
          state = await getDomainIdentity(row.domain, region);
        } catch (err) {
          console.error("[domains] ensureMailFrom failed:", err);
        }
      }
      // Recover a domain SES has permanently given up on. SES stops polling for
      // the DKIM CNAMEs 72h after the identity is created and parks the status at
      // FAILED; if the records only went live afterwards, re-reading it (which is
      // all this otherwise does) returns FAILED forever. When the published
      // records provably resolve, DNS isn't the problem, so reopen SES's window.
      //
      // requiredResolved gates this to the genuinely recoverable case, so a domain
      // whose records were never added doesn't get poked on every poll. The
      // restart normally clears the condition on its own (SES re-polls the
      // already-live CNAMEs and flips to SUCCESS within about a minute); beyond
      // that, cron never sweeps failed domains, so this only runs on an explicit
      // re-check, which enforceRateLimit above already throttles.
      const live = await resolveRecords(state.records);
      if (dkimWindowClosed(state.dkimStatus, live.requiredResolved)) {
        try {
          state = await restartDkim(row.domain, region);
          // SES keeps the existing tokens when the signing config is unchanged, so
          // this is usually a no-op, but if it ever does rotate them, a domain we
          // manage the DNS for would stall again waiting on records nobody
          // published. Best-effort: never let this fail the re-check.
          if (row.dnsAutoConfigured && row.dnsZoneId) {
            try {
              await publishToCloudflare(db, accountId, row.dnsZoneId, state.records);
            } catch (err) {
              console.error("[domains] DKIM restart: Cloudflare re-publish failed:", err);
            }
          }
        } catch (err) {
          console.error("[domains] restartDkim failed:", err);
        }
      }
      await db
        .update(sendingDomains)
        .set({
          verificationStatus: state.verificationStatus,
          dkimStatus: state.dkimStatus,
          mailFromDomain: state.mailFromDomain,
          mailFromStatus: state.mailFromStatus,
          dnsRecordsJson: JSON.stringify(state.records),
          updatedAt: nowIso(),
        })
        .where(eq(sendingDomains.id, row.id));
      const fresh = await findDomain(db, accountId, row.id);
      return {
        domain: fresh,
        dns: fresh ? await dnsFor(fresh) : { records: [], requiredResolved: false },
        registrar: await detectRegistrar(registrableRoot(row.domain)),
      };
    } catch (err) {
      console.error("[domains] SES GetEmailIdentity failed:", err);
    }
  }
  return {
    domain: row,
    dns: await dnsFor(row),
    registrar: await detectRegistrar(registrableRoot(row.domain)),
  };
}
