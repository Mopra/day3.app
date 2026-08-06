import { apiRoute } from "@/api/v1/route";
import { apiJson } from "@/api/v1/errors";
import { findCampaignOr404, serializeCampaign } from "@/api/v1/campaigns";
import { requireScope } from "@/api/v1/scopes";
import { withIdempotency } from "@/api/v1/idempotency";
import { submitCampaign } from "@/services/campaign-send";

type Params = { params: Promise<{ campaignId: string }> };

// POST /api/v1/campaigns/{id}/send — send the campaign to its audience, now.
//
// This is the irreversible one. It requires the `campaigns:send` scope, which is
// off unless the key was explicitly minted with it — an agent holding an
// ordinary key can write, preview and test an email all day and still cannot
// mail anyone. Once accepted, the campaign enters the automated risk review and,
// if it passes, delivery begins: there is no further human confirmation.
export const POST = apiRoute<Params>(async (req, ctx, { params }: Params) => {
  const { campaignId } = await params;
  requireScope(ctx.apiKey, "campaigns:send");
  const campaign = await findCampaignOr404(ctx.db, ctx.account.id, campaignId);

  return withIdempotency(ctx, req, "POST /v1/campaigns/send", { campaignId }, async () => {
    await submitCampaign(ctx.db, ctx.account, campaign);
    const updated = await findCampaignOr404(ctx.db, ctx.account.id, campaignId);
    return apiJson(serializeCampaign(updated));
  });
});
