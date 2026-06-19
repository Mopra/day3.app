import { desc, eq, inArray, sql } from "drizzle-orm";
import { route, json } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts, campaigns, jobLogs } from "@/db/schema";

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

  // Recent failed / dead-lettered jobs so an operator can see why work was lost
  // (failed imports, exhausted batches) without a manual SQL query.
  const failedJobs = await db
    .select()
    .from(jobLogs)
    .where(inArray(jobLogs.status, ["failed", "dead_letter"]))
    .orderBy(desc(jobLogs.createdAt))
    .limit(25);

  return json({
    accounts: Number(accountCount),
    pausedAccounts: Number(pausedAccounts),
    campaignsByStatus: Object.fromEntries(campaignCounts.map((r) => [r.status, Number(r.count)])),
    failedJobs,
  });
});
