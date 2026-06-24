import { and, eq, gt, isNotNull, isNull, lte, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, campaignRecipients, campaigns, sendingDomains } from "../db/schema";
import { campaignContentError, campaignSendGateError } from "../api/campaigns";
import { nowIso } from "../lib/ids";
import { DOMAIN_RECHECK_WINDOW_DAYS } from "../lib/domain";
import { logJob } from "../lib/job-log";
import { enforceAccountHealth } from "../services/health";
import { getDomainIdentity, type DomainIdentityState } from "../services/ses-identity";
import { SEND_BATCH_SIZE, type JobQueue } from "./messages";

const STUCK_LOCK_MINUTES = 15;
const DOMAIN_RECHECK_MAX = 50; // bound SES calls per sweep
// DOMAIN_RECHECK_WINDOW_DAYS: stop re-checking domains stale this long. Shared
// with the setup-guide UI (lib/domain) so both agree on when a domain has gone
// stale and needs a manual re-check.

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

// Scheduled campaigns whose time has come. Each is handed to the normal send
// pipeline exactly as the submit route would (status → pending_review, enqueue
// review_campaign), after re-checking the send gates — a domain may have lapsed
// or the audience emptied since scheduling. If a gate now fails, the campaign is
// returned to "draft" with a reason rather than silently dropped, so the user
// can see why it didn't go out. Granularity is the 15-minute sweep, so a send
// fires within ~15 minutes of its scheduled time.
export async function releaseDueCampaigns(
  db: Db,
  jobsQueue: JobQueue,
  now: Date,
): Promise<number> {
  const due = await db
    .select()
    .from(campaigns)
    .where(
      and(eq(campaigns.status, "scheduled"), lte(campaigns.scheduledAt, now.toISOString())),
    )
    .limit(50);

  let released = 0;
  for (const campaign of due) {
    const gateError =
      campaignContentError(campaign) ??
      (await campaignSendGateError(db, campaign.accountId, campaign));
    if (gateError) {
      await db
        .update(campaigns)
        .set({
          status: "draft",
          scheduledAt: null,
          pausedReason: `Scheduled send didn't start: ${gateError}`,
          updatedAt: nowIso(),
        })
        .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "scheduled")));
      continue;
    }

    // Claim the transition atomically so a concurrent sweep can't double-enqueue.
    const claimed = await db
      .update(campaigns)
      .set({ status: "pending_review", scheduledAt: null, pausedReason: null, updatedAt: nowIso() })
      .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "scheduled")))
      .returning({ id: campaigns.id });
    if (claimed.length === 0) continue;

    await jobsQueue.send({
      type: "review_campaign",
      campaignId: campaign.id,
      accountId: campaign.accountId,
    });
    released += 1;
  }
  return released;
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
      // Persist on any meaningful change — verification/DKIM (the gate) or the
      // optional Return-Path (mailFromStatus), so the setup guide reflects the
      // latest SES state even when only deliverability moved.
      if (
        state.verificationStatus !== domain.verificationStatus ||
        state.dkimStatus !== domain.dkimStatus ||
        state.mailFromStatus !== domain.mailFromStatus
      ) {
        await db
          .update(sendingDomains)
          .set({
            verificationStatus: state.verificationStatus,
            dkimStatus: state.dkimStatus,
            mailFromDomain: state.mailFromDomain,
            mailFromStatus: state.mailFromStatus,
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

// Fallback usage reset. The Clerk `subscriptionItem.active` webhook is the
// primary period source (it zeroes usage and advances the marker when a new
// period starts — see applySubscriptionEvent); this monthly cron only catches
// accounts whose period elapsed without a webhook arriving.
//
// To stay billing-correct it resets ONLY accounts whose current period has
// already ended (currentPeriodEnd in the past, or null for accounts that never
// received a billing webhook), never the whole table. After resetting it pushes
// the marker forward by a nominal period so the same elapsed period can't be
// reset twice — the next webhook overwrites it with the exact boundary.
const FALLBACK_PERIOD_DAYS = 31;
export async function resetMonthlyUsage(db: Db, now: Date = new Date()): Promise<number> {
  const nowMs = now.getTime();
  const nextEnd = new Date(nowMs + FALLBACK_PERIOD_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const reset = await db
    .update(accounts)
    .set({
      monthlyEmailSentCount: 0,
      currentPeriodStart: now.toISOString(),
      currentPeriodEnd: nextEnd,
      updatedAt: nowIso(),
    })
    .where(
      or(
        isNull(accounts.currentPeriodEnd),
        lt(accounts.currentPeriodEnd, now.toISOString()),
      ),
    )
    .returning({ id: accounts.id });
  return reset.length;
}

export type CronDeps = { db: Db; queue: JobQueue };

// The 15-minute sweep, formerly the Worker `scheduled` handler. Driven by a
// BullMQ repeatable job (worker/index.ts) instead of a Cron Trigger; `now` is
// injected so the daily/monthly branches stay testable.
export async function runScheduledSweeps(deps: CronDeps, now: Date = new Date()): Promise<void> {
  const { db, queue } = deps;

  const failed = await failStuckRecipients(db);
  const released = await releaseDueCampaigns(db, queue, now);
  await reconcileSendingCampaigns(db, queue);

  // SES re-check only when this process has SES configured.
  const region = process.env.AWS_REGION;
  const fetchIdentity = region ? (domain: string) => getDomainIdentity(domain, region) : null;
  const domainsVerified = await recheckPendingDomains(db, fetchIdentity);

  const isDaily = now.getUTCHours() === 3 && now.getUTCMinutes() < 15;
  if (isDaily) {
    await dailyHealthChecks(db);
    if (now.getUTCDate() === 1) {
      await resetMonthlyUsage(db, now);
    }
  }

  await logJob(db, {
    jobType: "cron",
    status: "completed",
    payload: { stuckFailed: failed, released, domainsVerified, daily: isDaily },
  });
}
