import { and, eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { sendingDomains } from "@/db/schema";

// Re-check verification with the provider. Phase 5 wires this to SES
// GetEmailIdentity (sets verification_status = verified when DKIM SUCCESS +
// VerifiedForSendingStatus). For now it just returns the stored row, and the
// admin override path remains the testing fallback.
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const row = await db.query.sendingDomains.findFirst({
    where: and(eq(sendingDomains.id, id), eq(sendingDomains.accountId, account.id)),
  });
  if (!row) throw new HttpError(404, "Not found");
  return json({ domain: row });
});
