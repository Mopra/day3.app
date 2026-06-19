import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { audiences, campaignRecipients, sendingDomains } from "../db/schema";

export const CampaignFieldsSchema = z.object({
  name: z.string().trim().min(1).max(150),
  subject: z.string().trim().min(1).max(200),
  previewText: z.string().trim().max(200).optional(),
  audienceId: z.string().min(1),
  sendingDomainId: z.string().min(1),
  fromName: z.string().trim().min(1).max(100),
  fromEmail: z.email().toLowerCase(),
  htmlBody: z.string().min(1).max(500_000),
  textBody: z.string().max(500_000).optional(),
});
export type CampaignFields = z.infer<typeof CampaignFieldsSchema>;

// Confirms the audience + sending domain belong to the account and the from
// address aligns with the domain. Returns an error string or null.
export async function validateOwnershipAndSender(
  db: Db,
  accountId: string,
  fields: CampaignFields,
): Promise<string | null> {
  const audience = await db.query.audiences.findFirst({
    where: and(eq(audiences.id, fields.audienceId), eq(audiences.accountId, accountId)),
  });
  if (!audience) return "Audience not found";

  const domain = await db.query.sendingDomains.findFirst({
    where: and(
      eq(sendingDomains.id, fields.sendingDomainId),
      eq(sendingDomains.accountId, accountId),
    ),
  });
  if (!domain) return "Sending domain not found";
  if (!fields.fromEmail.endsWith(`@${domain.domain}`)) {
    return "From email must use the selected sending domain";
  }
  return null;
}

export async function campaignStats(db: Db, campaignId: string) {
  const rows = await db
    .select({ status: campaignRecipients.status, count: sql<number>`count(*)`.as("count") })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaignId))
    .groupBy(campaignRecipients.status);
  const byStatus = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
  // Breakdown of why recipients did not receive the email, grouped by the stored
  // error. Lets the campaign UI distinguish suppressed (status=skipped, e.g.
  // "suppressed"/provider suppression) from hard-failed (status=failed, e.g. a
  // bad address or provider error) instead of showing a bare count.
  const reasonRows = await db
    .select({
      status: campaignRecipients.status,
      reason: campaignRecipients.error,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaignId),
        inArray(campaignRecipients.status, ["skipped", "failed"]),
      ),
    )
    .groupBy(campaignRecipients.status, campaignRecipients.error);
  const undeliverable = reasonRows.map((r) => ({
    status: r.status,
    reason: r.reason ?? "unknown",
    count: Number(r.count),
  }));
  return { total, ...byStatus, undeliverable };
}
