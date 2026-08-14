import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { listCampaigns } from "@/api/lists";
import {
  CampaignDraftSchema,
  campaignBodyFields,
  campaignThemeJson,
  validateDraftOwnership,
} from "@/api/campaigns";
import { campaigns } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { enforceRateLimit } from "@/lib/rate-limit";

export const GET = route(async () => {
  const { db, account } = await requireAccount();
  return json({ campaigns: await listCampaigns(db, account.id) });
});

export const POST = route(async (req) => {
  const { db, account } = await requireAccount();
  await enforceRateLimit("campaign_create", account.id);
  // Drafts are autosaved as the user types, so this accepts partial content and
  // stores empty strings for anything not filled in yet. Completeness is enforced
  // at submit/schedule time (campaignContentError).
  const data = await parseJson(req, CampaignDraftSchema);
  const error = await validateDraftOwnership(db, account.id, data);
  if (error) throw new HttpError(400, error);

  const id = newId("cmp");
  const now = nowIso();
  const body = campaignBodyFields(data);
  await db.insert(campaigns).values({
    id,
    accountId: account.id,
    audienceId: data.audienceId ?? "",
    segmentId: data.segmentId || null,
    topicId: data.topicId || null,
    sendingDomainId: data.sendingDomainId ?? "",
    senderId: data.senderId || null,
    name: data.name ?? "",
    subject: data.subject ?? "",
    previewText: data.previewText ?? null,
    fromName: data.fromName ?? "",
    fromEmail: data.fromEmail ?? "",
    replyTo: data.replyTo || null,
    htmlBody: body.htmlBody,
    sectionsJson: body.sectionsJson,
    themeJson: campaignThemeJson(data),
    textBody: data.textBody ?? null,
    footerText: data.footerText || null,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });
  return json({ id }, 201);
});
