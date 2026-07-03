import { desc, eq, inArray, or, sql } from "drizzle-orm";
import { route, json } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts, campaigns } from "@/db/schema";

// Campaigns needing attention: blocked / pending_review, or any with medium+ risk.
export const GET = route(async () => {
  const { db } = await requireAdmin();
  const rows = await db
    .select({
      campaign: campaigns,
      accountName: accounts.name,
      // `campaigns.audience_id` is written literally — interpolating the Drizzle
      // column can render it unqualified, which resolves to s.audience_id and
      // makes the correlation match every subscriber.
      audienceCount: sql<number>`(
        SELECT count(*)::int FROM subscribers s
        WHERE s.audience_id = campaigns.audience_id AND s.status = 'subscribed'
      )`.as("audienceCount"),
    })
    .from(campaigns)
    .innerJoin(accounts, eq(accounts.id, campaigns.accountId))
    .where(
      or(
        eq(campaigns.status, "blocked"),
        eq(campaigns.status, "pending_review"),
        inArray(campaigns.riskLevel, ["medium", "high", "blocked"]),
      ),
    )
    .orderBy(desc(campaigns.updatedAt))
    .limit(100);
  return json({ reviews: rows });
});
