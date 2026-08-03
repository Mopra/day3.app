import { and, eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findDomain } from "@/api/finders";
import { dnsIntegrations, sendingDomains } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logJob } from "@/lib/job-log";
import { parseDnsRecords } from "@/lib/domain";
import { findZone, writeRecords } from "@/services/cloudflare-dns";
import { CloudflareReauthRequiredError, getValidAccessToken } from "@/services/cloudflare-oauth";
import { getDomainIdentity } from "@/services/ses-identity";

// Write this domain's verification records into the customer's Cloudflare zone
// using their connected OAuth token. Idempotent: re-running skips records that
// are already correct. SES verification is unchanged — the UI keeps polling
// /check, which flips the domain to verified once the records propagate.
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();

  const domain = await findDomain(db, account.id, id);
  if (!domain) throw new HttpError(404, "Not found");

  const integration = await db.query.dnsIntegrations.findFirst({
    where: and(eq(dnsIntegrations.accountId, account.id), eq(dnsIntegrations.provider, "cloudflare")),
  });
  if (!integration) throw new HttpError(409, "Connect Cloudflare first");

  // Records are produced by SES on domain-add; back-fill from SES if missing.
  let records = parseDnsRecords(domain.dnsRecordsJson);
  const region = process.env.AWS_REGION;
  if (records.length === 0 && region && domain.provider === "ses") {
    try {
      const state = await getDomainIdentity(domain.domain, region);
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
        .where(eq(sendingDomains.id, domain.id));
      records = state.records;
    } catch (err) {
      console.error("[domains] auto-configure: SES record fetch failed", err);
    }
  }
  if (records.length === 0) {
    throw new HttpError(400, "DNS records aren't ready yet — try again in a moment");
  }

  let token: string;
  try {
    token = await getValidAccessToken(db, integration);
  } catch (err) {
    if (err instanceof CloudflareReauthRequiredError) {
      throw new HttpError(
        409,
        "Your Cloudflare connection has expired. Reconnect Cloudflare, then try again.",
      );
    }
    throw err;
  }
  const zone = await findZone(token, domain.domain);
  if (!zone) {
    const msg = "We couldn't find this domain in your Cloudflare account";
    await db
      .update(sendingDomains)
      .set({ dnsWriteError: msg, updatedAt: nowIso() })
      .where(eq(sendingDomains.id, domain.id));
    throw new HttpError(422, msg);
  }

  const results = await writeRecords(token, zone.id, records);
  const errors = results.filter((r) => r.action === "error");
  // Conflicts are a deliberate no-op on an optional deliverability record we
  // declined to overwrite, not a failure: verification only needs the DKIM CNAMEs.
  // Keep them out of dnsWriteError so the domain doesn't wear an error banner for
  // working DNS — they're returned in `results` for the UI to present as a choice.
  const conflicts = results.filter((r) => r.action === "conflict");

  await db
    .update(sendingDomains)
    .set({
      dnsZoneId: zone.id,
      dnsAutoConfigured: true,
      dnsWriteError: errors.length ? errors.map((e) => e.error).join("; ") : null,
      updatedAt: nowIso(),
    })
    .where(eq(sendingDomains.id, domain.id));

  await logJob(db, {
    jobType: "dns_write",
    entityType: "domain",
    entityId: domain.id,
    status: errors.length ? "failed" : "completed",
    error: errors.length ? errors.map((e) => e.error).join("; ") : undefined,
    payload: {
      zoneId: zone.id,
      actions: results.map((r) => ({ name: r.record.name, action: r.action })),
      // Record what we declined to overwrite, so an operator debugging a
      // deliverability complaint can see the zone already had its own value.
      ...(conflicts.length
        ? {
            conflicts: conflicts.map((c) => ({
              name: c.record.name,
              type: c.record.type,
              existing: c.existing,
              ours: c.record.value,
            })),
          }
        : {}),
    },
  });

  const fresh = await findDomain(db, account.id, domain.id);
  return json({ domain: fresh, results });
});
