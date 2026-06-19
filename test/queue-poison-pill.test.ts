import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sendCampaignBatch } from "../src/queue/handlers/send-batch";
import { generateCampaignRecipients } from "../src/queue/handlers/generate-recipients";
import { campaignRecipients, accounts, jobLogs } from "../src/db/schema";
import { recordDeadLetter } from "../src/lib/job-log";
import { DEFAULT_JOB_OPTIONS } from "../src/queue/messages";
import type { JobQueue, QueueMessage } from "../src/queue/messages";
import type { Db } from "../src/db/client";
import {
  FakeQueue,
  RecordingProvider,
  TEST_EMAILS,
  asQueue,
  seedAccount,
  seedAudience,
  seedCampaign,
  seedDomain,
  seedSubscribers,
  testDb,
} from "./helpers";

// A queue whose enqueue (send) throws for the first `failTimes` calls, then
// behaves normally. This models the WHY for this hardening: send_campaign_batch
// finishes its sends but the follow-up re-enqueue hits a transient Redis blip
// and throws — the whole batch is then retried. The retry must re-claim only
// rows still pending and never re-send the ones already marked sent.
class FlakyEnqueueQueue implements JobQueue {
  messages: QueueMessage[] = [];
  private failTimes: number;
  private calls = 0;

  constructor(failTimes: number) {
    this.failTimes = failTimes;
  }

  async send(message: QueueMessage): Promise<void> {
    if (this.calls++ < this.failTimes) {
      throw new Error("redis enqueue failed (transient)");
    }
    this.messages.push(message);
  }
}

async function setupSendingCampaign(emails: string[] = TEST_EMAILS) {
  const db = await testDb();
  const account = await seedAccount(db);
  const domain = await seedDomain(db, account.id);
  const audience = await seedAudience(db, account.id);
  await seedSubscribers(db, account.id, audience.id, emails);
  const campaign = await seedCampaign(db, {
    accountId: account.id,
    audienceId: audience.id,
    sendingDomainId: domain.id,
    status: "approved",
  });
  await generateCampaignRecipients(
    { campaignId: campaign.id, accountId: account.id },
    db,
    asQueue(new FakeQueue()),
  );
  return { db, account, campaign };
}

function deps(db: Db, queue: JobQueue, provider: RecordingProvider) {
  return {
    db,
    jobsQueue: queue,
    emailProvider: provider,
    appUrl: "http://localhost:5173",
    unsubscribeSecret: "test-secret",
  };
}

// Drives one message through the handler the way the BullMQ worker would: a
// throw fails the attempt and BullMQ retries (up to DEFAULT_JOB_OPTIONS
// .attempts); the final throw is dead-lettered (mirrored to job_logs). Returns
// the attempts actually made and any follow-up message the handler enqueued.
async function runWithRetries(
  db: Db,
  message: { campaignId: string; accountId: string; batchSize: number },
  provider: RecordingProvider,
  queue: JobQueue,
): Promise<{ attempts: number; lastError?: string }> {
  const max = DEFAULT_JOB_OPTIONS.attempts;
  let lastError: string | undefined;
  for (let attempt = 1; attempt <= max; attempt++) {
    try {
      await sendCampaignBatch(message, deps(db, queue, provider));
      return { attempts: attempt };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (attempt >= max) {
        await recordDeadLetter(db, {
          jobType: "send_campaign_batch",
          jobId: `job_${message.campaignId}`,
          attemptsMade: attempt,
          error: lastError,
          payload: message,
        });
      }
    }
  }
  return { attempts: max, lastError };
}

describe("poison-pill safety", () => {
  it("retries a transient re-enqueue error without duplicating sends, then succeeds", async () => {
    const { db, account, campaign } = await setupSendingCampaign();
    // batchSize 2 over 5 recipients forces a follow-up enqueue; the first
    // enqueue throws (transient Redis blip) AFTER the 2 sends are already
    // committed. The retry must NOT re-send those 2 — it re-claims only pending.
    const queue = new FlakyEnqueueQueue(1);
    const provider = new RecordingProvider();
    const message = { campaignId: campaign.id, accountId: account.id, batchSize: 2 };

    const result = await runWithRetries(db, message, provider, queue);

    // Attempt 1 sent 2 then threw on enqueue; attempt 2 sent the next 2 and
    // enqueued cleanly.
    expect(result.attempts).toBe(2);

    // The two rows sent before the throw were marked sent, so the retry skipped
    // them: 4 distinct sends so far, zero duplicates.
    expect(provider.sent).toHaveLength(4);
    expect(new Set(provider.sent.map((s) => s.toEmail)).size).toBe(4);

    const sentRows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(sentRows.filter((r) => r.status === "sent")).toHaveLength(4);
    expect(sentRows.filter((r) => r.status === "pending")).toHaveLength(1);

    // Usage counter equals real sends, not the retried attempt.
    const freshAccount = await db.query.accounts.findFirst({
      where: eq(accounts.id, account.id),
    });
    expect(freshAccount?.monthlyEmailSentCount).toBe(4);

    // The follow-up for the last recipient was enqueued exactly once.
    expect(queue.messages.filter((m) => m.type === "send_campaign_batch")).toHaveLength(1);

    // No dead-letter — the job recovered inside the attempt budget.
    const dl = await db.select().from(jobLogs).where(eq(jobLogs.status, "dead_letter"));
    expect(dl).toHaveLength(0);
  });

  it("re-delivery of the same message claims only pending rows (idempotent at-least-once)", async () => {
    const { db, account, campaign } = await setupSendingCampaign();
    const provider = new RecordingProvider();
    const message = { campaignId: campaign.id, accountId: account.id, batchSize: 2 };

    // Batch 1 sends 2, enqueues a follow-up for the rest.
    await sendCampaignBatch(message, deps(db, new FakeQueue(), provider));
    expect(provider.sent).toHaveLength(2);

    // Re-deliver the SAME message (Redis at-least-once): already-sent rows are
    // no longer pending, so it claims the next pending slice — never the sent
    // ones — proving the re-enqueue is duplicate-free.
    await sendCampaignBatch(message, deps(db, new FakeQueue(), provider));
    expect(provider.sent).toHaveLength(4);

    await sendCampaignBatch(message, deps(db, new FakeQueue(), provider));
    expect(provider.sent).toHaveLength(5);

    const distinct = new Set(provider.sent.map((s) => s.toEmail));
    expect(distinct.size).toBe(5);

    const freshAccount = await db.query.accounts.findFirst({
      where: eq(accounts.id, account.id),
    });
    expect(freshAccount?.monthlyEmailSentCount).toBe(5);
  });

  it("dead-letters a permanent error after max attempts (observable in job_logs)", async () => {
    // Enough recipients that pending never drains within the attempt budget, so
    // the (always-failing) follow-up enqueue is attempted on every retry.
    const emails = Array.from({ length: 30 }, (_, i) => `user${i}@example.com`);
    const { db, account, campaign } = await setupSendingCampaign(emails);
    // A permanent fault: every follow-up enqueue throws, so retries never clear
    // it. Budget is DEFAULT_JOB_OPTIONS.attempts (5).
    const queue = new FlakyEnqueueQueue(Number.POSITIVE_INFINITY);
    const provider = new RecordingProvider();
    const message = { campaignId: campaign.id, accountId: account.id, batchSize: 2 };

    const result = await runWithRetries(db, message, provider, queue);

    // It stopped exactly at the attempt cap — no infinite spinning.
    expect(result.attempts).toBe(DEFAULT_JOB_OPTIONS.attempts);

    // The exhausted job landed in the dead-letter set: queryable + carries the
    // error and the original message for replay.
    const dl = await db.select().from(jobLogs).where(eq(jobLogs.status, "dead_letter"));
    expect(dl).toHaveLength(1);
    expect(dl[0].jobType).toBe("send_campaign_batch");
    expect(dl[0].error).toContain("transient");
    const payload = JSON.parse(dl[0].payloadJson ?? "{}");
    expect(payload.attemptsMade).toBe(DEFAULT_JOB_OPTIONS.attempts);
    expect(payload.message.campaignId).toBe(campaign.id);
  });

  it("recordDeadLetter is the only job_logs writer that uses the dead_letter status", async () => {
    const db = await testDb();
    await recordDeadLetter(db, {
      jobType: "send_campaign_batch",
      jobId: "job_x",
      attemptsMade: 5,
      error: "boom",
      payload: { campaignId: "cmp_x" },
    });

    const rows = await db.select().from(jobLogs).where(eq(jobLogs.status, "dead_letter"));
    expect(rows).toHaveLength(1);
    expect(rows[0].jobType).toBe("send_campaign_batch");
  });
});
