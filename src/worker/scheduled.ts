import { and, eq, lt, sql } from "drizzle-orm";
import { createDb, type Db } from "./db/client";
import { accounts, campaignRecipients, campaigns } from "./db/schema";
import { nowIso } from "./lib/ids";
import { logJob } from "./lib/job-log";
import { enforceAccountHealth } from "./services/health";
import { SEND_BATCH_SIZE, type QueueMessage } from "./queue/messages";

const STUCK_LOCK_MINUTES = 15;

// Recipients stuck in "sending" belong to a crashed batch. The email may or
// may not have left — re-sending could duplicate, so they become "failed",
// never "pending" again.
async function failStuckRecipients(db: Db): Promise<number> {
  const cutoff = new Date(Date.now() - STUCK_LOCK_MINUTES * 60 * 1000).toISOString();
  const updated = await db
    .update(campaignRecipients)
    .set({
      status: "failed",
      error: "send attempt did not complete (stuck lock)",
      updatedAt: nowIso(),
    })
    .where(
      and(eq(campaignRecipients.status, "sending"), lt(campaignRecipients.lockedAt, cutoff)),
    )
    .returning({ id: campaignRecipients.id, campaignId: campaignRecipients.campaignId });
  return updated.length;
}

// Campaigns sitting in "sending" with no pending/in-flight recipients (e.g.
// after a stuck-lock sweep) are finished; ones with pending rows but no queue
// message get a nudge.
async function reconcileSendingCampaigns(db: Db, jobsQueue: Queue<QueueMessage>): Promise<void> {
  const sending = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.status, "sending"))
    .limit(50);

  for (const campaign of sending) {
    const [{ pending }] = await db
      .select({ pending: sql<number>`count(*)`.as("pending") })
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.campaignId, campaign.id),
          eq(campaignRecipients.status, "pending"),
        ),
      );
    const [{ inFlight }] = await db
      .select({ inFlight: sql<number>`count(*)`.as("inFlight") })
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.campaignId, campaign.id),
          eq(campaignRecipients.status, "sending"),
        ),
      );

    if (Number(pending) > 0) {
      await jobsQueue.send({
        type: "send_campaign_batch",
        campaignId: campaign.id,
        accountId: campaign.accountId,
        batchSize: SEND_BATCH_SIZE,
      });
    } else if (Number(inFlight) === 0) {
      await db
        .update(campaigns)
        .set({ status: "sent", sentAt: nowIso(), updatedAt: nowIso() })
        .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "sending")));
      await enforceAccountHealth(db, campaign.accountId);
    }
  }
}

async function dailyHealthChecks(db: Db): Promise<void> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.riskStatus, "normal"));
  for (const row of rows) {
    await enforceAccountHealth(db, row.id);
  }
}

// First day of the month: reset usage counters. Clerk Billing periods are
// mirrored when webhooks deliver them; the monthly cron is the fallback reset.
async function resetMonthlyUsage(db: Db): Promise<void> {
  await db
    .update(accounts)
    .set({ monthlyEmailSentCount: 0, updatedAt: nowIso() })
    .where(sql`1 = 1`);
}

export async function handleScheduled(controller: ScheduledController, env: Env): Promise<void> {
  const db = createDb(env.DB);

  const failed = await failStuckRecipients(db);
  await reconcileSendingCampaigns(db, env.JOBS_QUEUE);

  const now = new Date(controller.scheduledTime);
  const isDaily = now.getUTCHours() === 3 && now.getUTCMinutes() < 15;
  if (isDaily) {
    await dailyHealthChecks(db);
    if (now.getUTCDate() === 1) {
      await resetMonthlyUsage(db);
    }
  }

  await logJob(db, {
    jobType: "cron",
    status: "completed",
    payload: { cron: controller.cron, stuckFailed: failed, daily: isDaily },
  });
}
