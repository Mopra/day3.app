import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { findCampaignOr404, serializeCampaign } from "@/api/v1/campaigns";
import { requireScope } from "@/api/v1/scopes";
import { scheduleCampaign } from "@/services/campaign-send";
import { campaigns } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { eq } from "drizzle-orm";

type Params = { params: Promise<{ campaignId: string }> };

const ScheduleSchema = z.object({ send_at: z.string().min(1) });

// POST /api/v1/campaigns/{id}/schedule — park the campaign to send later.
// Scoped exactly like an immediate send: a scheduled send is still a send.
export const POST = apiRoute<Params>(async (req, ctx, { params }: Params) => {
  const { campaignId } = await params;
  requireScope(ctx.apiKey, "campaigns:send");
  const campaign = await findCampaignOr404(ctx.db, ctx.account.id, campaignId);
  const { send_at } = await readJson(req, ScheduleSchema);

  const when = new Date(send_at);
  if (Number.isNaN(when.getTime())) {
    throw new ApiError(400, "invalid_request", "`send_at` must be an ISO-8601 timestamp", {
      param: "send_at",
    });
  }
  await scheduleCampaign(ctx.db, ctx.account, campaign, when);
  const updated = await findCampaignOr404(ctx.db, ctx.account.id, campaignId);
  return apiJson(serializeCampaign(updated));
});

// DELETE /api/v1/campaigns/{id}/schedule — put a scheduled campaign back into
// draft. Un-scheduling cancels a send, so it needs no scope of its own: the
// dangerous direction is the one that starts email flowing.
export const DELETE = apiRoute<Params>(async (_req, ctx, { params }: Params) => {
  const { campaignId } = await params;
  const campaign = await findCampaignOr404(ctx.db, ctx.account.id, campaignId);
  if (campaign.status !== "scheduled") {
    throw new ApiError(
      409,
      "invalid_request",
      `Only a scheduled campaign can be unscheduled (this one is "${campaign.status}").`,
    );
  }
  await ctx.db
    .update(campaigns)
    .set({ status: "draft", scheduledAt: null, updatedAt: nowIso() })
    .where(eq(campaigns.id, campaign.id));
  const updated = await findCampaignOr404(ctx.db, ctx.account.id, campaignId);
  return apiJson(serializeCampaign(updated));
});
