import { eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findDomain } from "@/api/finders";
import { sendingDomains } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { parseDnsRecords } from "@/lib/domain";
import { requiredRecordsResolve } from "@/services/dns-resolve";
import { getDomainIdentity } from "@/services/ses-identity";

// Confirm the DKIM CNAMEs are live in public DNS (independent of SES). Verified
// domains are trivially "resolved"; otherwise we do a quick DoH lookup so the UI
// can show "DNS confirmed — finalizing with provider" while SES catches up.
async function dnsResolvedFor(domain: { verificationStatus: string; dnsRecordsJson: string | null }) {
  if (domain.verificationStatus === "verified") return true;
  return requiredRecordsResolve(parseDnsRecords(domain.dnsRecordsJson));
}

// Re-check verification with SES (GetEmailIdentity). When VerifiedForSendingStatus
// is true the domain flips to "verified" — SES's own status is authoritative. The
// admin override path remains the testing fallback.
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const row = await findDomain(db, account.id, id);
  if (!row) throw new HttpError(404, "Not found");

  const region = process.env.AWS_REGION;
  if (region && row.provider === "ses") {
    try {
      const state = await getDomainIdentity(row.domain, region);
      await db
        .update(sendingDomains)
        .set({
          verificationStatus: state.verificationStatus,
          dkimStatus: state.dkimStatus,
          dnsRecordsJson: JSON.stringify(state.records),
          updatedAt: nowIso(),
        })
        .where(eq(sendingDomains.id, row.id));
      const fresh = await findDomain(db, account.id, row.id);
      return json({ domain: fresh, dnsResolved: fresh ? await dnsResolvedFor(fresh) : false });
    } catch (err) {
      console.error("[domains] SES GetEmailIdentity failed:", err);
    }
  }
  return json({ domain: row, dnsResolved: await dnsResolvedFor(row) });
});
