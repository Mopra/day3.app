import { and, eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { sendingDomains } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { getDomainIdentity } from "@/services/ses-identity";

// Re-check verification with SES (GetEmailIdentity). When VerifiedForSendingStatus
// is true the domain flips to "verified" — SES's own status is authoritative. The
// admin override path remains the testing fallback.
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const row = await db.query.sendingDomains.findFirst({
    where: and(eq(sendingDomains.id, id), eq(sendingDomains.accountId, account.id)),
  });
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
      const fresh = await db.query.sendingDomains.findFirst({
        where: eq(sendingDomains.id, row.id),
      });
      return json({ domain: fresh });
    } catch (err) {
      console.error("[domains] SES GetEmailIdentity failed:", err);
    }
  }
  return json({ domain: row });
});
