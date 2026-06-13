import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { campaigns, riskReviews, sendingDomains } from "../../db/schema";
import { newId, nowIso } from "../../lib/ids";
import { logJob } from "../../lib/job-log";
import { reviewCampaignRisk } from "../../services/risk";
import type { QueueMessage } from "../messages";

export async function reviewCampaign(
  message: { campaignId: string; accountId: string },
  db: Db,
  jobsQueue: Queue<QueueMessage>,
  aiReviewMode: string | undefined,
): Promise<void> {
  const campaign = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, message.campaignId), eq(campaigns.accountId, message.accountId)),
  });

  // Idempotency: only a campaign waiting for review is processed.
  if (!campaign || campaign.status !== "pending_review") {
    await logJob(db, {
      jobType: "review_campaign",
      entityType: "campaign",
      entityId: message.campaignId,
      status: "skipped",
      error: campaign ? `status is ${campaign.status}` : "campaign not found",
    });
    return;
  }

  const domain = await db.query.sendingDomains.findFirst({
    where: eq(sendingDomains.id, campaign.sendingDomainId),
  });

  const review = await reviewCampaignRisk(
    {
      subject: campaign.subject,
      htmlBody: campaign.htmlBody,
      textBody: campaign.textBody,
      fromEmail: campaign.fromEmail,
      sendingDomain: domain?.domain ?? "",
    },
    aiReviewMode,
  );

  await db.insert(riskReviews).values({
    id: newId("rsk"),
    accountId: campaign.accountId,
    campaignId: campaign.id,
    riskLevel: review.riskLevel,
    riskScore: review.riskScore,
    categoriesJson: JSON.stringify(review.categories),
    summary: review.summary,
    recommendedAction: review.recommendedAction,
    createdAt: nowIso(),
  });

  // MVP decision rules: low/medium approve (medium stays flagged for admin),
  // high/blocked block.
  const approved = review.riskLevel === "low" || review.riskLevel === "medium";

  await db
    .update(campaigns)
    .set({
      status: approved ? "approved" : "blocked",
      riskLevel: review.riskLevel,
      riskScore: review.riskScore,
      riskSummary: review.summary,
      riskCategoriesJson: JSON.stringify(review.categories),
      updatedAt: nowIso(),
    })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "pending_review")));

  if (approved) {
    await jobsQueue.send({
      type: "generate_campaign_recipients",
      campaignId: campaign.id,
      accountId: campaign.accountId,
    });
  }

  await logJob(db, {
    jobType: "review_campaign",
    entityType: "campaign",
    entityId: campaign.id,
    status: "completed",
    payload: { riskLevel: review.riskLevel, riskScore: review.riskScore, approved },
  });
}
