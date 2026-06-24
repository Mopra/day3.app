import { eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { campaignContentError, campaignSendGateError } from "@/api/campaigns";
import { campaigns } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { checkSendEligibility } from "@/services/plans";
import { getQueue } from "@/queue/producer";
import { enforceRateLimit } from "@/lib/rate-limit";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  await enforceRateLimit("campaign_submit", account.id);
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");

  const eligibility = checkSendEligibility(account);
  if (!eligibility.allowed) throw new HttpError(403, eligibility.reason);

  if (campaign.status !== "draft" && campaign.status !== "approved") {
    throw new HttpError(409, `Campaign cannot be submitted from status "${campaign.status}"`);
  }

  // Drafts can be saved incomplete (autosave), so confirm the content is complete
  // before sending.
  const contentError = campaignContentError(campaign);
  if (contentError) throw new HttpError(400, contentError);

  // Domain-verified + audience-has-subscribers gates (account-scoped so a
  // cross-tenant id can never satisfy the verified check).
  const gateError = await campaignSendGateError(db, account.id, campaign);
  if (gateError) throw new HttpError(gateError.includes("verified") ? 403 : 400, gateError);

  await db
    .update(campaigns)
    .set({ status: "pending_review", scheduledAt: null, pausedReason: null, updatedAt: nowIso() })
    .where(eq(campaigns.id, campaign.id));

  await getQueue().send({
    type: "review_campaign",
    campaignId: campaign.id,
    accountId: account.id,
  });
  return json({ ok: true });
});
