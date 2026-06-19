import { eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findDomain } from "@/api/finders";
import { sendingDomains } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { parseDnsRecords } from "@/lib/domain";
import { resolveRecords } from "@/services/dns-resolve";
import { ensureMailFrom, getDomainIdentity } from "@/services/ses-identity";
import { enforceRateLimit } from "@/lib/rate-limit";

// Per-record live status via DoH (independent of SES) so the UI can show each
// record as "Found"/"Waiting". `requiredResolved` covers only the DKIM (verify)
// records; deliverability rows (Return-Path/DMARC) report their own status.
function dnsFor(domain: { dnsRecordsJson: string | null }) {
  return resolveRecords(parseDnsRecords(domain.dnsRecordsJson));
}

// Re-check verification with SES (GetEmailIdentity). When VerifiedForSendingStatus
// is true the domain flips to "verified" — SES's own status is authoritative. The
// admin override path remains the testing fallback.
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  await enforceRateLimit("domain_recheck", account.id);
  const row = await findDomain(db, account.id, id);
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
      const fresh = await findDomain(db, account.id, row.id);
      return json({
        domain: fresh,
        dns: fresh ? await dnsFor(fresh) : { records: [], requiredResolved: false },
      });
    } catch (err) {
      console.error("[domains] SES GetEmailIdentity failed:", err);
    }
  }
  return json({ domain: row, dns: await dnsFor(row) });
});
