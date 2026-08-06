import { eq } from "drizzle-orm";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import {
  CampaignInputSchema,
  EDITABLE_STATUSES,
  findCampaignOr404,
  serializeCampaign,
  updateCampaign,
} from "@/api/v1/campaigns";
import { campaignRecipients, campaigns } from "@/db/schema";

type Params = { params: Promise<{ campaignId: string }> };

// GET /api/v1/campaigns/{id} — includes the body as markdown, sections and html.
export const GET = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { campaignId } = await params;
  const campaign = await findCampaignOr404(db, account.id, campaignId);
  return apiJson(serializeCampaign(campaign, { body: true }));
});

// PATCH /api/v1/campaigns/{id} — partial update of an editable campaign.
export const PATCH = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { campaignId } = await params;
  const campaign = await findCampaignOr404(db, account.id, campaignId);
  const body = await readJson(req, CampaignInputSchema);
  const updated = await updateCampaign(db, account.id, campaign, body);
  return apiJson(serializeCampaign(updated, { body: true }));
});

// DELETE /api/v1/campaigns/{id} — only ever a draft or a parked schedule. A
// campaign that has reached the send pipeline is a record of email that went
// out (or is going out) and stays put.
export const DELETE = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { campaignId } = await params;
  const campaign = await findCampaignOr404(db, account.id, campaignId);
  if (!EDITABLE_STATUSES.has(campaign.status)) {
    throw new ApiError(
      409,
      "invalid_request",
      `A campaign with status "${campaign.status}" cannot be deleted.`,
    );
  }
  await db.delete(campaignRecipients).where(eq(campaignRecipients.campaignId, campaign.id));
  await db.delete(campaigns).where(eq(campaigns.id, campaign.id));
  return apiJson({ id: campaign.id, object: "campaign", deleted: true });
});
