import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { enforceRateLimit } from "@/lib/rate-limit";
import { submitCampaign } from "@/services/campaign-send";

// Hands the campaign to the review→send pipeline. Every gate lives in
// services/campaign-send, shared with POST /v1/campaigns/{id}/send.
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  await enforceRateLimit("campaign_submit", account.id);
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");

  await submitCampaign(db, account, campaign);
  return json({ ok: true });
});
