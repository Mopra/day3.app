import { desc, eq, sql } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts, campaigns, riskReviews, subscribers } from "@/db/schema";
import { computeAccountHealth } from "@/services/health";

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { db } = await requireAdmin();
  const { id } = await params;
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, id) });
  if (!account) throw new HttpError(404, "Not found");

  const health = await computeAccountHealth(db, account.id);
  const accountCampaigns = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.accountId, account.id))
    .orderBy(desc(campaigns.createdAt))
    .limit(50);
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

  return json({
    account,
    health,
    campaigns: accountCampaigns,
    subscriberCount: Number(subscriberCount),
    riskReviews: reviews,
  });
});
