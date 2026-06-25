import { and, eq } from "drizzle-orm";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import {
  CampaignDraftSchema,
  campaignBodyFields,
  campaignPersonalizationGaps,
  campaignStats,
  campaignThemeJson,
  validateDraftOwnership,
} from "@/api/campaigns";
import { campaignRecipients, campaigns, riskReviews } from "@/db/schema";
import { safeParseSections } from "@/lib/sections";
import { safeParseTheme } from "@/lib/theme";
import { nowIso } from "@/lib/ids";

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");
  const review = await db.query.riskReviews.findFirst({
    where: and(eq(riskReviews.campaignId, campaign.id), eq(riskReviews.accountId, account.id)),
  });
  // Personalization gaps only matter pre-send (draft/approved); skip the extra
  // count query once the campaign is in flight or done.
  const submittable = campaign.status === "draft" || campaign.status === "approved";
  return json({
    // Surface the structured sections + theme (parsed from the stored JSON) so the
    // composer can rehydrate the builder and styling panel; htmlBody remains the
    // canonical serialized body.
    campaign: {
      ...campaign,
      sections: safeParseSections(campaign.sectionsJson),
      theme: safeParseTheme(campaign.themeJson),
    },
    riskReview: review ?? null,
    stats: await campaignStats(db, campaign.id),
    personalization: submittable
      ? await campaignPersonalizationGaps(db, account.id, campaign)
      : [],
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

  // Autosave sends a full snapshot of the draft on each change; partial content
  // is fine (empty strings stored). Send-readiness is enforced on submit/schedule.
  const data = await parseJson(req, CampaignDraftSchema);
  const error = await validateDraftOwnership(db, account.id, data);
  if (error) throw new HttpError(400, error);

  // htmlBody is derived from `sections` when present (see campaignBodyFields), so the
  // stored body always matches the builder and is email-safe by construction.
  const body = campaignBodyFields(data);

  await db
    .update(campaigns)
    .set({
      name: data.name ?? "",
      subject: data.subject ?? "",
      previewText: data.previewText ?? null,
      audienceId: data.audienceId ?? "",
      sendingDomainId: data.sendingDomainId ?? "",
      senderId: data.senderId || null,
      fromName: data.fromName ?? "",
      fromEmail: data.fromEmail ?? "",
      replyTo: data.replyTo || null,
      htmlBody: body.htmlBody,
      sectionsJson: body.sectionsJson,
      themeJson: campaignThemeJson(data),
      textBody: data.textBody ?? null,
      footerText: data.footerText || null,
      updatedAt: nowIso(),
    })
    .where(eq(campaigns.id, campaign.id));
  return json({ ok: true });
});

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");

  // Block deletion only while the send pipeline is actively touching this
  // campaign: the worker is building the recipient list or draining sends and
  // re-reads rows by id (hard rule: idempotency / no duplicate sends). Pause it
  // first. Every other status — draft, scheduled, paused, sent, failed, blocked
  // — is safe to delete; cron and the queue look the campaign up by id, so a
  // missing row is simply a no-op.
  if (campaign.status === "generating_recipients" || campaign.status === "sending") {
    throw new HttpError(409, "Pause the campaign before deleting it");
  }

  // Remove the per-recipient rows and any risk review first, then the campaign.
  // email_events are kept as an immutable analytics/audit log (campaign_id there
  // is nullable provenance), mirroring how senders keep historical snapshots.
  await db.delete(campaignRecipients).where(eq(campaignRecipients.campaignId, campaign.id));
  await db.delete(riskReviews).where(eq(riskReviews.campaignId, campaign.id));
  await db.delete(campaigns).where(eq(campaigns.id, campaign.id));
  return json({ ok: true });
});
