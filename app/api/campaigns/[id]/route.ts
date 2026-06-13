import { eq } from "drizzle-orm";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import {
  CampaignFieldsSchema,
  campaignStats,
  validateOwnershipAndSender,
} from "@/api/campaigns";
import { campaigns, riskReviews } from "@/db/schema";
import { nowIso } from "@/lib/ids";

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");
  const review = await db.query.riskReviews.findFirst({
    where: eq(riskReviews.campaignId, campaign.id),
  });
  return json({
    campaign,
    riskReview: review ?? null,
    stats: await campaignStats(db, campaign.id),
  });
});

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");
  if (campaign.status !== "draft") {
    throw new HttpError(409, "Only draft campaigns can be edited");
  }

  const data = await parseJson(req, CampaignFieldsSchema);
  const error = await validateOwnershipAndSender(db, account.id, data);
  if (error) throw new HttpError(400, error);

  await db
    .update(campaigns)
    .set({
      name: data.name,
      subject: data.subject,
      previewText: data.previewText ?? null,
      audienceId: data.audienceId,
      sendingDomainId: data.sendingDomainId,
      fromName: data.fromName,
      fromEmail: data.fromEmail,
      htmlBody: data.htmlBody,
      textBody: data.textBody ?? null,
      updatedAt: nowIso(),
    })
    .where(eq(campaigns.id, campaign.id));
  return json({ ok: true });
});
