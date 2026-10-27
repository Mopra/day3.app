import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accounts, campaigns, riskReviews, sendingDomains } from "../../db/schema";
import { newId, nowIso } from "../../lib/ids";
import { logJob } from "../../lib/job-log";
import { notifyAccount } from "../../services/notifications";
import { reviewCampaignRisk } from "../../services/risk";
import type { JobQueue } from "../messages";

export async function reviewCampaign(
  message: { campaignId: string; accountId: string },
  db: Db,
  jobsQueue: JobQueue,
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
      fromName: campaign.fromName,
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
    guidanceJson: review.guidance.length > 0 ? JSON.stringify(review.guidance) : null,
    // The AI verdict (or the failure that made the review fall back to
    // deterministic-only) — audit trail for the admin queue and cost tracking.
    rawResponseJson: review.ai
      ? JSON.stringify(review.ai)
      : review.aiError
        ? JSON.stringify({ aiError: review.aiError })
        : null,
    createdAt: nowIso(),
  });

  // Decision rule: a review whose recommended action is `block` never sends.
  //   - `blocked` is terminal: the campaign is refused (duplicate and edit).
  //   - `high` is HELD: paused with code `review` before a single recipient is
  //     generated, and only an admin can release it (approve) or refuse it.
  //   - low / medium approve, and medium stays flagged in the admin queue.
  //
  // `high` used to approve-and-flag, on the theory that the new-account ramp
  // bounds the damage. It does not bound it enough: on 2026-10-27 the AI pass
  // rated a new account's campaign `high` (recommended action `block`), the
  // campaign was approved anyway, and 475 emails went out in 15 seconds before
  // the 500/day ramp stopped it. A flag in the admin queue is read after the
  // fact; the hold is read before.
  //
  // It is a hold rather than a block because `high` is reachable by soft
  // signals honest first-week mail carries ("sign in to your account" in a
  // product update with many links, a bit.ly in a welcome email). A blocked
  // campaign can only be duplicated; a held one can be duplicated too, or
  // released as it is by an admin who reads it. The
  // transactional path keeps its own rule (content-review.ts isBlocking).
  const verdict: "approved" | "held" | "blocked" =
    review.riskLevel === "blocked"
      ? "blocked"
      : review.recommendedAction === "block"
        ? "held"
        : "approved";
  const approved = verdict === "approved";

  const transitioned = await db
    .update(campaigns)
    .set({
      status: verdict === "held" ? "paused" : verdict,
      riskLevel: review.riskLevel,
      riskScore: review.riskScore,
      riskSummary: review.summary,
      riskCategoriesJson: JSON.stringify(review.categories),
      ...(verdict === "held"
        ? {
            pausedCode: "review" as const,
            pausedReason:
              "Our pre-send review flagged this campaign as high risk, so it is held for a manual check before anything goes out. " +
              review.summary,
          }
        : {}),
      updatedAt: nowIso(),
    })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "pending_review")))
    .returning({ id: campaigns.id });

  if (approved) {
    await jobsQueue.send({
      type: "generate_campaign_recipients",
      campaignId: campaign.id,
      accountId: campaign.accountId,
    });
  } else if (transitioned.length > 0) {
    // A blocked or held campaign does not send: push that to the user instead
    // of letting them believe it went out (they may have closed the tab, or
    // this may be a scheduled send releasing while they're away). Guarded on
    // the status transition so a duplicate delivery can't notify twice;
    // best-effort so a notification failure never fails the review job after
    // the decision is already recorded.
    try {
      const account = await db.query.accounts.findFirst({
        where: eq(accounts.id, campaign.accountId),
      });
      if (account) {
        await notifyAccount(
          db,
          account,
          verdict === "blocked"
            ? {
                kind: "campaign_blocked",
                title: `"${campaign.name}" was blocked by the pre-send review`,
                body: `${review.summary} Duplicate the campaign, apply the guidance, and send the fixed copy.`,
                ctaHref: `/campaigns/${campaign.id}`,
                ctaLabel: "See why & fix it",
              }
            : {
                kind: "campaign_held",
                title: `"${campaign.name}" is held for a manual review`,
                body: `${review.summary} Nothing has been sent. To send now, duplicate the campaign, apply the guidance, and send the fixed copy; otherwise we check it by hand and release or refuse it.`,
                ctaHref: `/campaigns/${campaign.id}`,
                ctaLabel: "See why",
              },
        );
      }
    } catch (err) {
      console.error(`[review] ${verdict}-notification failed for ${campaign.id}:`, err);
    }
  }

  await logJob(db, {
    jobType: "review_campaign",
    entityType: "campaign",
    entityId: campaign.id,
    status: "completed",
    payload: {
      riskLevel: review.riskLevel,
      riskScore: review.riskScore,
      approved,
      verdict,
      // AI-pass observability: which model ran and what it cost in tokens, or
      // why it was skipped/failed (review then fell back to deterministic-only).
      ...(review.ai
        ? { aiModel: review.ai.model, aiUsage: review.ai.usage, aiRiskLevel: review.ai.riskLevel }
        : {}),
      ...(review.aiError ? { aiError: review.aiError } : {}),
    },
  });
}
