import { desc, eq, sql } from "drizzle-orm";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
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
  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      subject: campaigns.subject,
      status: campaigns.status,
      riskLevel: campaigns.riskLevel,
      scheduledAt: campaigns.scheduledAt,
      sentAt: campaigns.sentAt,
      createdAt: campaigns.createdAt,
      // Outer columns are written literally: an interpolated Drizzle column
      // renders UNQUALIFIED in single-table selects, so inside the subquery it
      // resolves against the subquery's own table and the correlation is lost.
      audienceName: sql<string>`(
        SELECT name FROM audiences a WHERE a.id = campaigns.audience_id
      )`.as("audienceName"),
      sentCount: sql<number>`(
        SELECT count(*)::int FROM campaign_recipients r
        WHERE r.campaign_id = campaigns.id AND r.status IN ('sent', 'delivered')
      )`.as("sentCount"),
    })
    .from(campaigns)
    .where(eq(campaigns.accountId, account.id))
    .orderBy(desc(campaigns.createdAt));
  return json({ campaigns: rows });
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
