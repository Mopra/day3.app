import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { campaignRecipients, campaigns } from "../db/schema";
import type { CampaignMetricCounts, CampaignMetricsRow } from "../lib/types";

// Per-campaign send metrics for an account, one row per campaign that has at
// least one recipient. Counts come from the per-recipient timestamp columns
// (sent_at, delivered_at, …) rather than the single `status` column, because an
// email can be delivered AND complained AND unsubscribed — those outcomes
// overlap, and `status` only holds the latest one. Timestamp-presence counts
// each outcome independently, which is what funnel/rate metrics need.
//
// `failed`/`skipped` have no timestamp (they're pre/at-send outcomes, not
// post-send feedback), so those two are still counted off `status`.
//
// Account-scoped (hard rule). The page sums these rows for the global view and
// picks one for the per-campaign view, recomputing rates client-side — so the
// campaign filter never costs a round trip.
export async function accountCampaignMetrics(
  db: Db,
  accountId: string,
): Promise<CampaignMetricsRow[]> {
  const rows = await db
    .select({
      campaignId: campaignRecipients.campaignId,
      name: campaigns.name,
      status: campaigns.status,
      sentAt: campaigns.sentAt,
      recipients: sql<number>`count(*)`,
      sent: sql<number>`count(*) filter (where ${campaignRecipients.sentAt} is not null)`,
      delivered: sql<number>`count(*) filter (where ${campaignRecipients.deliveredAt} is not null)`,
      opened: sql<number>`count(*) filter (where ${campaignRecipients.openedAt} is not null)`,
      clicked: sql<number>`count(*) filter (where ${campaignRecipients.clickedAt} is not null)`,
      bounced: sql<number>`count(*) filter (where ${campaignRecipients.bouncedAt} is not null)`,
      complained: sql<number>`count(*) filter (where ${campaignRecipients.complainedAt} is not null)`,
      unsubscribed: sql<number>`count(*) filter (where ${campaignRecipients.unsubscribedAt} is not null)`,
      failed: sql<number>`count(*) filter (where ${campaignRecipients.status} = 'failed')`,
      skipped: sql<number>`count(*) filter (where ${campaignRecipients.status} = 'skipped')`,
    })
    .from(campaignRecipients)
    .innerJoin(campaigns, eq(campaigns.id, campaignRecipients.campaignId))
    .where(eq(campaignRecipients.accountId, accountId))
    .groupBy(campaignRecipients.campaignId, campaigns.name, campaigns.status, campaigns.sentAt)
    // Most recently sent first; campaigns mid-send (no sent_at yet) sort last.
    .orderBy(sql`${campaigns.sentAt} desc nulls last`);

  return rows.map((r) => ({
    campaignId: r.campaignId,
    name: r.name,
    status: r.status,
    sentAt: r.sentAt,
    counts: {
      recipients: Number(r.recipients),
      sent: Number(r.sent),
      delivered: Number(r.delivered),
      opened: Number(r.opened),
      clicked: Number(r.clicked),
      bounced: Number(r.bounced),
      complained: Number(r.complained),
      unsubscribed: Number(r.unsubscribed),
      failed: Number(r.failed),
      skipped: Number(r.skipped),
    } satisfies CampaignMetricCounts,
  }));
}
