import { and, eq, gt, isNotNull, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, campaignRecipients, campaigns, sendingDomains } from "../db/schema";
import { nowIso } from "../lib/ids";
import { logJob } from "../lib/job-log";
import { enforceAccountHealth } from "../services/health";
import { getDomainIdentity, type DomainIdentityState } from "../services/ses-identity";
import { SEND_BATCH_SIZE, type JobQueue } from "./messages";

const STUCK_LOCK_MINUTES = 15;
const DOMAIN_RECHECK_MAX = 50; // bound SES calls per sweep
const DOMAIN_RECHECK_WINDOW_DAYS = 14; // stop re-checking domains stale this long

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
async function reconcileSendingCampaigns(db: Db, jobsQueue: JobQueue): Promise<void> {
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

// Pull the SES identity for a domain. Injected so the sweep is testable without
// AWS, and so a process without SES configured (no AWS_REGION) cleanly skips.
export type DomainIdentityFetcher = (domain: string) => Promise<DomainIdentityState>;

// Sync domains still waiting on SES verification into our DB, so a domain
// verifies even if the user closed the setup page (the send gate reads
// verificationStatus). SES verifies in the background regardless; this is the
// safety net for the client-side poll. Bounded per run, skips long-stale
// pending domains, and only writes when something actually changed.
export async function recheckPendingDomains(
  db: Db,
  fetchIdentity: DomainIdentityFetcher | null,
): Promise<number> {
  if (!fetchIdentity) return 0; // SES not configured in this process

  const cutoff = new Date(
    Date.now() - DOMAIN_RECHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const pending = await db
    .select()
    .from(sendingDomains)
    .where(
      and(
        eq(sendingDomains.verificationStatus, "pending"),
        eq(sendingDomains.provider, "ses"),
        isNotNull(sendingDomains.dnsRecordsJson),
        gt(sendingDomains.updatedAt, cutoff),
      ),
    )
    .limit(DOMAIN_RECHECK_MAX);

  let verified = 0;
  for (const domain of pending) {
    try {
      const state = await fetchIdentity(domain.domain);
      if (
        state.verificationStatus !== domain.verificationStatus ||
        state.dkimStatus !== domain.dkimStatus
      ) {
        await db
          .update(sendingDomains)
          .set({
            verificationStatus: state.verificationStatus,
            dkimStatus: state.dkimStatus,
            dnsRecordsJson: JSON.stringify(state.records),
            updatedAt: nowIso(),
          })
          .where(eq(sendingDomains.id, domain.id));
        if (state.verificationStatus === "verified") verified += 1;
      }
    } catch (err) {
      // One bad domain must not abort the sweep.
      console.error(`[cron] domain re-check failed for ${domain.domain}:`, err);
    }
  }
  return verified;
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

export type CronDeps = { db: Db; queue: JobQueue };

// The 15-minute sweep, formerly the Worker `scheduled` handler. Driven by a
// BullMQ repeatable job (worker/index.ts) instead of a Cron Trigger; `now` is
// injected so the daily/monthly branches stay testable.
export async function runScheduledSweeps(deps: CronDeps, now: Date = new Date()): Promise<void> {
  const { db, queue } = deps;

  const failed = await failStuckRecipients(db);
  await reconcileSendingCampaigns(db, queue);

  // SES re-check only when this process has SES configured.
  const region = process.env.AWS_REGION;
  const fetchIdentity = region ? (domain: string) => getDomainIdentity(domain, region) : null;
  const domainsVerified = await recheckPendingDomains(db, fetchIdentity);

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
    payload: { stuckFailed: failed, domainsVerified, daily: isDaily },
  });
}
