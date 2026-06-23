import { desc, eq, sql } from "drizzle-orm";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { CampaignFieldsSchema, validateOwnershipAndSender } from "@/api/campaigns";
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
      sentAt: campaigns.sentAt,
      createdAt: campaigns.createdAt,
      audienceName: sql<string>`(
        SELECT name FROM audiences a WHERE a.id = ${campaigns.audienceId}
      )`.as("audienceName"),
      sentCount: sql<number>`(
        SELECT count(*) FROM campaign_recipients r
        WHERE r.campaign_id = ${campaigns.id} AND r.status IN ('sent', 'delivered')
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
  const data = await parseJson(req, CampaignFieldsSchema);
  const error = await validateOwnershipAndSender(db, account.id, data);
  if (error) throw new HttpError(400, error);

  const id = newId("cmp");
  const now = nowIso();
  await db.insert(campaigns).values({
    id,
    accountId: account.id,
    audienceId: data.audienceId,
    sendingDomainId: data.sendingDomainId,
    senderId: data.senderId ?? null,
    name: data.name,
    subject: data.subject,
    previewText: data.previewText ?? null,
    fromName: data.fromName,
    fromEmail: data.fromEmail,
    replyTo: data.replyTo || null,
    htmlBody: data.htmlBody,
    textBody: data.textBody ?? null,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });
  return json({ id }, 201);
});
