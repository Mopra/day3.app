import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findDomain } from "@/api/finders";
import { listDomains } from "@/api/lists";
import { sendingDomains, senders } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { isDomainClaimed } from "@/services/domain-ownership";
import { createDomainIdentity } from "@/services/ses-identity";

export const GET = route(async () => {
  const { db, account } = await requireAccount();
  return json({ domains: await listDomains(db, account.id) });
});

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;

const CreateDomainSchema = z.object({
  domain: z
    .string()
    .trim()
    .toLowerCase()
    .regex(DOMAIN_RE, "Enter a valid domain like updates.example.com"),
  fromName: z.string().trim().min(1).max(100),
  fromEmail: z.email().toLowerCase(),
});

export const POST = route(async (req: NextRequest) => {
  const { db, account } = await requireAccount();
  const { domain, fromName, fromEmail } = await parseJson(req, CreateDomainSchema);

  if (!fromEmail.endsWith(`@${domain}`)) {
    throw new HttpError(400, "From email must use the sending domain");
  }

  // Domain ownership is GLOBAL, not per-tenant: one domain is one shared SES
  // identity, so letting a second account claim it would hand them a
  // "verified" row with no DNS proof — and the ability to send DKIM-signed mail
  // as the real owner. See services/domain-ownership.ts for the full reasoning.
  // The same 409 whether the holder is this account or another one: which
  // tenants use which domains isn't ours to leak.
  if (await isDomainClaimed(db, domain)) {
    throw new HttpError(409, "That domain is already added");
  }

  const id = newId("dom");
  const now = nowIso();
  try {
    await db.insert(sendingDomains).values({
      id,
      accountId: account.id,
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
    where: eq(senders.accountId, account.id),
  });
  await db
    .insert(senders)
    .values({
      id: newId("snd"),
      accountId: account.id,
      sendingDomainId: id,
      fromName,
      fromEmail,
      isDefault: !existingSender,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  // Headline feature: register the domain with SES (Easy DKIM) and store the
  // CNAME records to show the customer. Best-effort — if SES isn't configured or
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

  const row = await findDomain(db, account.id, id);
  return json({ domain: row }, 201);
});
