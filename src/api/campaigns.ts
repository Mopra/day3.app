import { and, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../db/client";
import { audiences, campaignRecipients, sendingDomains, subscribers } from "../db/schema";

export const CampaignFieldsSchema = z.object({
  name: z.string().trim().min(1).max(150),
  subject: z.string().trim().min(1).max(200),
  previewText: z.string().trim().max(200).optional(),
  audienceId: z.string().min(1),
  sendingDomainId: z.string().min(1),
  // The sender picked in the composer (provenance only; fromName/fromEmail below
  // are the authoritative snapshot). Optional for backward compatibility.
  senderId: z.string().optional(),
  fromName: z.string().trim().min(1).max(100),
  fromEmail: z.email().toLowerCase(),
  // Optional Reply-To: any valid address (often support@ on a different domain),
  // or empty to omit it. Normalised to lowercase; "" is treated as "no reply-to".
  replyTo: z
    .union([z.literal(""), z.email().toLowerCase()])
    .optional(),
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

// Campaign-level send gates shared by the submit route, the schedule route, and
// the cron release of due scheduled campaigns: the sending domain must be
// verified (or admin-overridden) and the audience must have at least one
// subscribed recipient. Returns an error string or null. (Account-level
// eligibility — billing/plan/health — is checked separately by the caller.)
export async function campaignSendGateError(
  db: Db,
  accountId: string,
  campaign: { sendingDomainId: string; audienceId: string },
): Promise<string | null> {
  const domain = await db.query.sendingDomains.findFirst({
    where: and(
      eq(sendingDomains.id, campaign.sendingDomainId),
      eq(sendingDomains.accountId, accountId),
    ),
  });
  const domainVerified =
    domain && (domain.verificationStatus === "verified" || domain.adminOverrideVerified);
  if (!domainVerified) return "Sending domain is not verified";

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(subscribers)
    .where(
      and(eq(subscribers.audienceId, campaign.audienceId), eq(subscribers.status, "subscribed")),
    );
  if (Number(count) === 0) return "The audience has no subscribed recipients";

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
