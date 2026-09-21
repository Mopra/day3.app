import { desc, eq, sql } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts, apiKeys, campaigns, contentReviews, riskReviews, subscribers } from "@/db/schema";
import { computeAccountHealth } from "@/services/health";
import { safeParseTheme } from "@/lib/theme";

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { db } = await requireAdmin();
  const { id } = await params;
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, id) });
  if (!account) throw new HttpError(404, "Not found");

  const health = await computeAccountHealth(db, account.id);
  const campaignRows = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.accountId, account.id))
    .orderBy(desc(campaigns.createdAt))
    .limit(50);
  // Parse the stored theme the same way GET /api/campaigns/[id] does: the admin
  // preview renders through wrapEmailDocument, which wants the theme, not the
  // raw JSON column.
  const accountCampaigns = campaignRows.map((c) => ({
    ...c,
    theme: safeParseTheme(c.themeJson),
  }));
  const [{ subscriberCount }] = await db
    .select({ subscriberCount: sql<number>`count(*)`.as("subscriberCount") })
    .from(subscribers)
    .where(eq(subscribers.accountId, account.id));
  const reviews = await db
    .select()
    .from(riskReviews)
    .where(eq(riskReviews.accountId, account.id))
    .orderBy(desc(riskReviews.createdAt))
    .limit(20);

  // What the pre-send review has been refusing for this account, worst and
  // busiest first. This is the operator's answer to "what is this account
  // actually trying to send" for API traffic, which — unlike campaigns — leaves
  // no draft behind to read.
  const blockedContent = await db
    .select()
    .from(contentReviews)
    .where(eq(contentReviews.accountId, account.id))
    .orderBy(desc(contentReviews.blockedCount), desc(contentReviews.createdAt))
    .limit(20);

  // API keys, so an operator responding to abuse can see which key is driving
  // it without a database session.
  const keys = await db
    .select({
      id: apiKeys.id,
      name: apiKeys.name,
      keyPrefix: apiKeys.keyPrefix,
      scopes: apiKeys.scopes,
      lastUsedAt: apiKeys.lastUsedAt,
      revokedAt: apiKeys.revokedAt,
      createdAt: apiKeys.createdAt,
    })
    .from(apiKeys)
    .where(eq(apiKeys.accountId, account.id))
    .orderBy(desc(apiKeys.createdAt));

  return json({
    account,
    health,
    blockedContent,
    apiKeys: keys,
    campaigns: accountCampaigns,
    subscriberCount: Number(subscriberCount),
    riskReviews: reviews,
  });
});
