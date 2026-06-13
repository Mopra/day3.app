import { eq, sql } from "drizzle-orm";
import { route, json } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts, campaigns } from "@/db/schema";

export const GET = route(async () => {
  const { db } = await requireAdmin();
  const [{ accountCount }] = await db
    .select({ accountCount: sql<number>`count(*)`.as("accountCount") })
    .from(accounts);
  const campaignCounts = await db
    .select({ status: campaigns.status, count: sql<number>`count(*)`.as("count") })
    .from(campaigns)
    .groupBy(campaigns.status);
  const [{ pausedAccounts }] = await db
    .select({ pausedAccounts: sql<number>`count(*)`.as("pausedAccounts") })
    .from(accounts)
    .where(eq(accounts.riskStatus, "paused"));

  return json({
    accounts: Number(accountCount),
    pausedAccounts: Number(pausedAccounts),
    campaignsByStatus: Object.fromEntries(campaignCounts.map((r) => [r.status, Number(r.count)])),
  });
});
