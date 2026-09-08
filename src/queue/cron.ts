import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lte, lt, or, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  accounts,
  automationEnrollments,
  campaignRecipients,
  campaigns,
  jobLogs,
  sendingDomains,
  transactionalEmails,
  webhookDeliveries,
  type Account,
} from "../db/schema";
import { campaignContentError, campaignSendGateError } from "../api/campaigns";
import { nowIso } from "../lib/ids";
import { DOMAIN_RECHECK_WINDOW_DAYS } from "../lib/domain";
import { logJob } from "../lib/job-log";
import { enforceAccountHealth } from "../services/health";
import { notifyAccount, notifyCampaignSent } from "../services/notifications";
import { checkSendEligibility } from "../services/plans";
import { releaseReservation } from "../services/quota";
import { getDomainIdentity, type DomainIdentityState } from "../services/ses-identity";
import { TRANSACTIONAL_BODY_RETENTION_DAYS } from "../services/transactional";
import { WEBHOOK_STUCK_LOCK_MS } from "../services/webhooks";
import { laneCountFor, SEND_BATCH_SIZE, type JobQueue } from "./messages";

const STUCK_LOCK_MINUTES = 15;
const DOMAIN_RECHECK_MAX = 50; // bound SES calls per sweep
// The verified pass is a slow patrol rather than a poll: a domain that has been
// working for months only needs re-reading often enough that a regression is
// caught before it costs the customer a campaign.
const VERIFIED_RECHECK_MAX = 25; // bound SES calls per sweep
const VERIFIED_RECHECK_EVERY_HOURS = 6;
const SWEEP_PAGE = 100; // campaigns examined per sweep per stage (ordered oldest-first, so nothing starves)
// DOMAIN_RECHECK_WINDOW_DAYS: stop re-checking domains stale this long. Shared
// with the setup-guide UI (lib/domain) so both agree on when a domain has gone
// stale and needs a manual re-check.

// Recipients stuck in "sending" belong to a crashed batch. The email may or
// may not have left — re-sending could duplicate, so they become "failed",
// never "pending" again. Live batches refresh lockedAt mid-batch (see
// send-batch.ts refreshLocks), so a row this stale really is abandoned.
//
// Their quota reservation is released here: a crashed batch never ran its
// flush, so the reservation for these rows is still held — without this, every
// crash permanently inflates the account's usage counter by up to a batch. (At
// most one row per crashed lane may actually have reached the provider — the
// crash-between-send-and-write window — so this can under-count by ≤1 per
// crash, a far smaller error than over-counting by ~100.)
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
    .returning({
      id: campaignRecipients.id,
      campaignId: campaignRecipients.campaignId,
      accountId: campaignRecipients.accountId,
    });

  const byAccount = new Map<string, number>();
  for (const row of updated) {
    byAccount.set(row.accountId, (byAccount.get(row.accountId) ?? 0) + 1);
  }
  for (const [accountId, count] of byAccount) {
    await releaseReservation(db, accountId, count);
  }
  return updated.length;
}

// Transactional emails need the same crash-recovery treatment as campaign
// recipients, with the same duplicate-safety rule: a row stuck in "sending"
// (worker crashed mid-send) may or may not have left, so it becomes "failed",
// never "queued" again. Rows stuck in "queued", by contrast, provably never
// sent (the claim is what flips them out of queued) — those get their job
// re-enqueued (dead-lettered retries, Redis data loss) up to a give-up window,
// after which they fail and release their quota reservation.
const TRANSACTIONAL_REQUEUE_MS = 15 * 60 * 1000; // healthy retries keep updatedAt fresher than this
const TRANSACTIONAL_GIVE_UP_MS = 6 * 60 * 60 * 1000; // a 6h-late transactional email is better failed loudly
export async function sweepTransactionalEmails(
  db: Db,
  jobsQueue: JobQueue,
  now: Date,
): Promise<{ failed: number; requeued: number }> {
  const nowMs = now.getTime();

  // 1) Crashed mid-send → failed (may have reached the provider; never retry).
  const lockCutoff = new Date(nowMs - STUCK_LOCK_MINUTES * 60 * 1000).toISOString();
  const stuck = await db
    .update(transactionalEmails)
    .set({
      status: "failed",
      error: "send attempt did not complete (stuck lock)",
      lockedAt: null,
      updatedAt: nowIso(),
    })
    .where(
      and(eq(transactionalEmails.status, "sending"), lt(transactionalEmails.lockedAt, lockCutoff)),
    )
    .returning({ accountId: transactionalEmails.accountId, to: transactionalEmails.to });

  // 2) Queued too long overall → failed + reservation released (provably unsent).
  const giveUpCutoff = new Date(nowMs - TRANSACTIONAL_GIVE_UP_MS).toISOString();
  const givenUp = await db
    .update(transactionalEmails)
    .set({
      status: "failed",
      error: "send could not be completed (gave up after repeated retries)",
      updatedAt: nowIso(),
    })
    .where(
      and(eq(transactionalEmails.status, "queued"), lt(transactionalEmails.createdAt, giveUpCutoff)),
    )
    .returning({ accountId: transactionalEmails.accountId, to: transactionalEmails.to });

  // A stuck-lock row's email may have left (crash after handoff), so like the
  // campaign sweep we release its reservation anyway — erring by ≤1 per crash
  // beats permanently inflating the counter. Given-up rows provably never sent.
  const byAccount = new Map<string, number>();
  for (const row of [...stuck, ...givenUp]) {
    byAccount.set(row.accountId, (byAccount.get(row.accountId) ?? 0) + row.to.length);
  }
  for (const [accountId, count] of byAccount) {
    await releaseReservation(db, accountId, count);
  }

  // 3) Queued with no live job → re-enqueue (idempotent: the handler's claim
  // makes a duplicate job a no-op). Stamp updatedAt first so the next sweep
  // doesn't re-enqueue the same row while its fresh job waits its turn.
  const requeueCutoff = new Date(nowMs - TRANSACTIONAL_REQUEUE_MS).toISOString();
  const stale = await db
    .update(transactionalEmails)
    .set({ updatedAt: nowIso() })
    .where(
      and(eq(transactionalEmails.status, "queued"), lt(transactionalEmails.updatedAt, requeueCutoff)),
    )
    .returning({ id: transactionalEmails.id, accountId: transactionalEmails.accountId });
  for (const row of stale) {
    try {
      await jobsQueue.send({ type: "send_transactional", emailId: row.id, accountId: row.accountId });
    } catch (err) {
      // Next sweep retries once the row goes stale again.
      console.error(`[cron] transactional re-enqueue failed for ${row.id}:`, err);
    }
  }

  return { failed: stuck.length + givenUp.length, requeued: stale.length };
}

// Automation enrollments need the same two recoveries as the send ledger.
//
//   1. `sending` with a stale lock: the send job died between claiming the
//      enrollment and moving its cursor. The email may or may not have left
//      (the ledger row, if one exists, is failed by failStuckRecipients on the
//      same sweep), so the enrollment becomes `failed` with the reason on
//      lastError, and NEVER goes back to `active`: re-dispatching the node could
//      mail the same person twice. Same window, same rule as campaigns.
//   2. `active` and due for longer than a tick could plausibly miss: the
//      backstop for a lost advance job or a tick that ran out of budget. The
//      advance handler is a no-op unless the row is still due, so re-enqueueing
//      every sweep is harmless.
const AUTOMATION_BACKSTOP_MS = 5 * 60 * 1000;
const AUTOMATION_BACKSTOP_PAGE = 500;
export async function sweepAutomationEnrollments(
  db: Db,
  jobsQueue: JobQueue,
  now: Date,
): Promise<{ failed: number; requeued: number }> {
  const lockCutoff = new Date(now.getTime() - STUCK_LOCK_MINUTES * 60 * 1000).toISOString();
  const stuck = await db
    .update(automationEnrollments)
    .set({
      status: "failed",
      lastError: "send did not complete (stuck lock)",
      lockedAt: null,
      updatedAt: nowIso(),
    })
    .where(
      and(eq(automationEnrollments.status, "sending"), lt(automationEnrollments.lockedAt, lockCutoff)),
    )
    .returning({ id: automationEnrollments.id });

  // A failed enrollment can leave a `pending` ledger row behind: the send
  // handler gives the row back on a provably-unsent provider result and throws
  // for BullMQ to retry, so when the retries run out the row stays pending with
  // nobody left to claim it. Resolve it so the canvas does not count it as
  // in-flight forever. Its reservation (if one is still held) is left alone: a
  // pending row cannot say whether the handler released it, and over-counting
  // is the accepted safe side of the quota ledger.
  if (stuck.length > 0) {
    await db
      .update(campaignRecipients)
      .set({
        status: "failed",
        error: "enrollment failed before the send was attempted (stuck lock)",
        updatedAt: nowIso(),
      })
      .where(
        and(
          inArray(
            campaignRecipients.automationEnrollmentId,
            stuck.map((s) => s.id),
          ),
          eq(campaignRecipients.status, "pending"),
        ),
      );
  }

  const dueCutoff = new Date(now.getTime() - AUTOMATION_BACKSTOP_MS).toISOString();
  const overdue = await db
    .select({ id: automationEnrollments.id, accountId: automationEnrollments.accountId })
    .from(automationEnrollments)
    .where(
      and(eq(automationEnrollments.status, "active"), lt(automationEnrollments.nextRunAt, dueCutoff)),
    )
    .orderBy(asc(automationEnrollments.nextRunAt))
    .limit(AUTOMATION_BACKSTOP_PAGE);
  let requeued = 0;
  for (const row of overdue) {
    try {
      await jobsQueue.send({
        type: "advance_automation_enrollment",
        enrollmentId: row.id,
        accountId: row.accountId,
      });
      requeued += 1;
    } catch (err) {
      // Next sweep (or the next tick) picks it up.
      console.error(`[cron] automation advance re-enqueue failed for ${row.id}:`, err);
    }
  }
  return { failed: stuck.length, requeued };
}

// Storage hygiene: transactional bodies are full HTML documents; after the
// retention window only the metadata row (status, recipients, timestamps)
// stays queryable. bodyPrunedAt lets the UI/API say "content expired" instead
// of implying the email was sent empty.
export async function pruneTransactionalBodies(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(
    now.getTime() - TRANSACTIONAL_BODY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const pruned = await db
    .update(transactionalEmails)
    .set({ htmlBody: null, textBody: null, bodyPrunedAt: nowIso(), updatedAt: nowIso() })
    .where(
      and(
        lt(transactionalEmails.createdAt, cutoff),
        isNull(transactionalEmails.bodyPrunedAt),
        // Never prune an email that hasn't reached a terminal state (a queued
        // row this old is the sweep's problem, not the pruner's).
        inArray(transactionalEmails.status, [
          "sent",
          "delivered",
          "bounced",
          "complained",
          "failed",
          "suppressed",
        ]),
      ),
    )
    .returning({ id: transactionalEmails.id });
  return pruned.length;
}

// job_logs is append-only and had no retention: every sweep writes a `cron` row,
// so it grows by ~96 rows/day forever whether or not anything happened. It backs
// two liveness reads (the /api/health cron staleness check and the dailyChecksDue
// marker), which only ever want the newest row per job_type, plus the admin
// overview's recent-failures list. Keeping ~30 days satisfies all three and keeps
// the table small enough that a mistuned query can't become an outage.
// Webhook deliveries examined per sweep. Ordered oldest-due-first so a backlog
// drains in order and nothing starves.
const WEBHOOK_SWEEP_PAGE = 200;

/**
 * Recovers outbound webhook deliveries the queue lost track of. Two cases, and
 * both are why webhook_deliveries is a Postgres outbox rather than "whatever is
 * in Redis":
 *
 *   1. `pending` with nextAttemptAt in the past — the enqueue never landed
 *      (Redis blip at emission, or the retry enqueue failed), so no job exists
 *      to run it. Emission is deliberately best-effort for this reason: the row
 *      is the durable part.
 *   2. `delivering` with a stale lock — a worker claimed the row and died
 *      mid-POST. Unlike a campaign send, this is safe to return to `pending`:
 *      the receiver is contractually idempotent on the event id (we send that
 *      header precisely so a redelivery is a no-op), and the alternative —
 *      dropping the event — is the failure this system exists to prevent.
 */
export async function sweepWebhookDeliveries(
  db: Db,
  queue: JobQueue,
  now: Date = new Date(),
): Promise<number> {
  const nowStr = now.toISOString();
  const lockCutoff = new Date(now.getTime() - WEBHOOK_STUCK_LOCK_MS).toISOString();

  // Reclaim stuck locks first so they're eligible for the due-scan below.
  await db
    .update(webhookDeliveries)
    .set({ status: "pending", lockedAt: null, nextAttemptAt: nowStr, updatedAt: nowStr })
    .where(
      and(
        eq(webhookDeliveries.status, "delivering"),
        lt(webhookDeliveries.lockedAt, lockCutoff),
      ),
    );

  const due = await db
    .select({ id: webhookDeliveries.id, accountId: webhookDeliveries.accountId })
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.status, "pending"),
        lte(webhookDeliveries.nextAttemptAt, nowStr),
      ),
    )
    .orderBy(asc(webhookDeliveries.nextAttemptAt))
    .limit(WEBHOOK_SWEEP_PAGE);

  for (const row of due) {
    // A duplicate enqueue is harmless — the handler's guarded claim means only
    // one of the two jobs does any work.
    await queue.send({ type: "deliver_webhook", deliveryId: row.id, accountId: row.accountId });
  }
  return due.length;
}

// Delivery rows are a debugging log, not a ledger anything depends on, and they
// accumulate at roughly (events × endpoints). Pruned on the same daily cadence
// as job_logs.
export const WEBHOOK_DELIVERY_RETENTION_DAYS = 30;

export async function pruneWebhookDeliveries(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(
    now.getTime() - WEBHOOK_DELIVERY_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  const deleted = await db
    .delete(webhookDeliveries)
    .where(
      and(
        lt(webhookDeliveries.createdAt, cutoff),
        inArray(webhookDeliveries.status, ["succeeded", "failed"]),
      ),
    )
    .returning({ id: webhookDeliveries.id });
  return deleted.length;
}

export const JOB_LOG_RETENTION_DAYS = 30;

export async function pruneJobLogs(db: Db, now: Date): Promise<number> {
  const cutoff = new Date(
    now.getTime() - JOB_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();
  // Successful routine rows only. Failures and dead letters are the operator's
  // audit trail for lost work — those age out on their own far more slowly, and
  // deleting them would erase the record of a send that never happened.
  const pruned = await db
    .delete(jobLogs)
    .where(and(lt(jobLogs.createdAt, cutoff), inArray(jobLogs.status, ["completed", "skipped"])))
    .returning({ id: jobLogs.id });
  return pruned.length;
}

// Campaigns sitting in "sending" with no pending/in-flight recipients (e.g.
// after a stuck-lock sweep) are finished; ones with pending rows but no live
// batch get re-fanned-out. One poison campaign must not abort the loop for the
// rest — each iteration is isolated.
async function reconcileSendingCampaigns(db: Db, jobsQueue: JobQueue): Promise<void> {
  const sending = await db
    .select()
    .from(campaigns)
    .where(eq(campaigns.status, "sending"))
    .orderBy(asc(campaigns.updatedAt))
    .limit(SWEEP_PAGE);

  for (const campaign of sending) {
    try {
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
        // Nudge ONLY when nothing is in flight. inFlight > 0 means live lanes
        // are draining (or a crash under 15 minutes old that failStuckRecipients
        // clears next sweep) — nudging a healthy campaign would add one
        // self-chaining lane per sweep and push aggregate throughput past the
        // SES rate SEND_LANES was tuned for. A genuinely stalled campaign
        // (dead-lettered lanes, lost follow-up enqueue) has inFlight = 0 and
        // gets restored to full lane width, not a single limping lane.
        if (Number(inFlight) === 0) {
          const lanes = laneCountFor(Number(pending));
          for (let lane = 0; lane < lanes; lane++) {
            await jobsQueue.send({
              type: "send_campaign_batch",
              campaignId: campaign.id,
              accountId: campaign.accountId,
              batchSize: SEND_BATCH_SIZE,
            });
          }
        }
      } else if (Number(inFlight) === 0) {
        const completed = await db
          .update(campaigns)
          .set({ status: "sent", sentAt: nowIso(), updatedAt: nowIso() })
          .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "sending")))
          .returning({ id: campaigns.id });
        await enforceAccountHealth(db, campaign.accountId);
        // If this reconcile is the one that completed the send (the worker's last
        // batch didn't), it owns the "campaign sent" notification.
        if (completed.length > 0) {
          await notifyCampaignSent(db, campaign);
        }
      }
    } catch (err) {
      console.error(`[cron] reconcile failed for campaign ${campaign.id}:`, err);
    }
  }
}

// Auto-resume for pauses the system caused and can safely undo. Only the
// machine codes rate_limit / daily_limit / quota qualify — user pauses and the
// codes that need a human (account, config, suspended, error) are never
// touched. Resume claims the paused→sending transition atomically, then
// restores full lane width.
const RESUME_RATE_LIMIT_MS = 10 * 60 * 1000; // throttle: back off one sweep
const RESUME_DAILY_LIMIT_MS = 2 * 60 * 60 * 1000; // daily quota: try every ~2h until the window rolls
export async function resumePausedCampaigns(
  db: Db,
  jobsQueue: JobQueue,
  now: Date,
): Promise<number> {
  const candidates = await db
    .select()
    .from(campaigns)
    .where(
      and(
        eq(campaigns.status, "paused"),
        inArray(campaigns.pausedCode, ["rate_limit", "daily_limit", "quota"]),
      ),
    )
    .orderBy(asc(campaigns.updatedAt))
    .limit(SWEEP_PAGE);

  let resumed = 0;
  for (const campaign of candidates) {
    try {
      const pausedAgoMs = now.getTime() - Date.parse(campaign.updatedAt);
      if (campaign.pausedCode === "rate_limit" && pausedAgoMs < RESUME_RATE_LIMIT_MS) continue;
      if (campaign.pausedCode === "daily_limit" && pausedAgoMs < RESUME_DAILY_LIMIT_MS) continue;

      const account = await db.query.accounts.findFirst({
        where: eq(accounts.id, campaign.accountId),
      });
      if (!account) continue;
      // For quota pauses this is the actual resume condition (headroom is back
      // after a monthly reset or an upgrade); for the others it guards against
      // resuming into an account that got paused/past-due in the meantime.
      if (!checkSendEligibility(account).allowed) continue;

      const claimed = await db
        .update(campaigns)
        .set({ status: "sending", pausedReason: null, pausedCode: null, updatedAt: nowIso() })
        .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "paused")))
        .returning({ id: campaigns.id });
      if (claimed.length === 0) continue;

      const [{ pending }] = await db
        .select({ pending: sql<number>`count(*)`.as("pending") })
        .from(campaignRecipients)
        .where(
          and(
            eq(campaignRecipients.campaignId, campaign.id),
            eq(campaignRecipients.status, "pending"),
          ),
        );
      // pending = 0 → the reconcile stage completes it to "sent"; no lanes needed.
      const lanes = Number(pending) > 0 ? laneCountFor(Number(pending)) : 0;
      for (let lane = 0; lane < lanes; lane++) {
        await jobsQueue.send({
          type: "send_campaign_batch",
          campaignId: campaign.id,
          accountId: campaign.accountId,
          batchSize: SEND_BATCH_SIZE,
        });
      }
      resumed += 1;
    } catch (err) {
      console.error(`[cron] auto-resume failed for campaign ${campaign.id}:`, err);
    }
  }
  return resumed;
}

// The intermediate pipeline states (pending_review, approved,
// generating_recipients) are pure job-driven pass-throughs: if the driving job
// is lost — enqueue failed after the status flip, job dead-lettered after a
// minutes-long outage, Redis data loss — the campaign would sit there forever
// with the user believing it went out, and the submit route 409s a re-submit.
// Both downstream handlers are idempotent on status and dedupe-safe, so
// re-enqueueing after a generous staleness window is free.
const PIPELINE_RESCUE_MS = 30 * 60 * 1000;
export async function rescueStuckPipelineCampaigns(
  db: Db,
  jobsQueue: JobQueue,
  now: Date,
): Promise<number> {
  const cutoff = new Date(now.getTime() - PIPELINE_RESCUE_MS).toISOString();
  const stuck = await db
    .select()
    .from(campaigns)
    .where(
      and(
        inArray(campaigns.status, ["pending_review", "approved", "generating_recipients"]),
        lt(campaigns.updatedAt, cutoff),
      ),
    )
    .orderBy(asc(campaigns.updatedAt))
    .limit(SWEEP_PAGE);

  let rescued = 0;
  for (const campaign of stuck) {
    try {
      // Reset the staleness clock first so a queued-but-slow rescue job isn't
      // re-enqueued by every subsequent sweep while it waits.
      await db
        .update(campaigns)
        .set({ updatedAt: nowIso() })
        .where(eq(campaigns.id, campaign.id));
      await jobsQueue.send(
        campaign.status === "pending_review"
          ? { type: "review_campaign", campaignId: campaign.id, accountId: campaign.accountId }
          : {
              type: "generate_campaign_recipients",
              campaignId: campaign.id,
              accountId: campaign.accountId,
            },
      );
      await logJob(db, {
        jobType: "cron_rescue",
        entityType: "campaign",
        entityId: campaign.id,
        status: "completed",
        payload: { from: campaign.status },
      });
      rescued += 1;
    } catch (err) {
      console.error(`[cron] pipeline rescue failed for campaign ${campaign.id}:`, err);
    }
  }
  return rescued;
}

// Scheduled campaigns whose time has come. Each is handed to the normal send
// pipeline exactly as the submit route would (status → pending_review, enqueue
// review_campaign), after re-checking the send gates — a domain may have lapsed
// or the audience emptied since scheduling. If a gate now fails, the campaign is
// returned to "draft" with a reason rather than silently dropped, so the user
// can see why it didn't go out. Granularity is the 15-minute sweep, so a send
// fires within ~15 minutes of its scheduled time. Ordered by scheduledAt so a
// burst of same-minute schedules releases oldest-first instead of arbitrarily.
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
    .orderBy(asc(campaigns.scheduledAt))
    .limit(SWEEP_PAGE);

  let released = 0;
  for (const campaign of due) {
    try {
      // Account eligibility is re-checked here, not just the campaign-level
      // gates: this is the moment the send starts, and the plan/billing state
      // may have moved since scheduling. It also resolves the send *mode* —
      // an org that dropped to the free tier while its campaign sat scheduled
      // releases as a sandbox send rather than failing at the first batch.
      const account = await db.query.accounts.findFirst({
        where: eq(accounts.id, campaign.accountId),
      });
      const eligibility = account ? checkSendEligibility(account) : null;
      const sandbox = eligibility?.allowed ? eligibility.sandbox : false;
      const gateError =
        !account
          ? "the account no longer exists"
          : !eligibility?.allowed
            ? eligibility?.reason ?? "sending is not available on this account"
            : (campaignContentError(campaign) ??
              (await campaignSendGateError(db, campaign.accountId, campaign, { sandbox })));
      if (gateError) {
        const reverted = await db
          .update(campaigns)
          .set({
            status: "draft",
            scheduledAt: null,
            pausedReason: `Scheduled send didn't start: ${gateError}`,
            updatedAt: nowIso(),
          })
          .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "scheduled")))
          .returning({ id: campaigns.id });
        // Tell the user — a scheduled send that silently reverts to draft is the
        // worst kind of surprise (they think it went out). Best-effort; the DB
        // change above is the source of truth. Only notify if we actually claimed
        // the transition (a concurrent sweep may have handled it).
        if (reverted.length > 0) {
          if (account) {
            await notifyAccount(db, account, {
              kind: "scheduled_send_failed",
              title: `Your scheduled send didn't go out: "${campaign.name}"`,
              body: `We couldn't start the scheduled send because: ${gateError} The campaign is back in your drafts — fix that and send again when you're ready.`,
              ctaHref: `/campaigns/${campaign.id}`,
              ctaLabel: "Open the campaign",
            });
          }
        }
        continue;
      }

      // Claim the transition atomically so a concurrent sweep can't double-enqueue.
      const claimed = await db
        .update(campaigns)
        .set({ status: "pending_review", sandbox, scheduledAt: null, pausedReason: null, pausedCode: null, updatedAt: nowIso() })
        .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "scheduled")))
        .returning({ id: campaigns.id });
      if (claimed.length === 0) continue;

      await jobsQueue.send({
        type: "review_campaign",
        campaignId: campaign.id,
        accountId: campaign.accountId,
      });
      released += 1;
    } catch (err) {
      // One broken campaign/account row must not block the other due releases;
      // this one is retried next sweep (still status "scheduled").
      console.error(`[cron] release failed for campaign ${campaign.id}:`, err);
    }
  }
  return released;
}

// Pull the SES identity for a domain. Injected so the sweep is testable without
// AWS, and so a process without SES configured (no AWS_REGION) cleanly skips.
export type DomainIdentityFetcher = (domain: string) => Promise<DomainIdentityState>;

// The identity fields a re-check can move, and the row shape holding them. Both
// sweeps share these so "something changed" means the same thing in each, and so
// a field added to one write cannot be forgotten in the other.
type IdentityRow = { verificationStatus: string; dkimStatus: string; mailFromStatus: string };

function identityMoved(row: IdentityRow, state: DomainIdentityState): boolean {
  return (
    state.verificationStatus !== row.verificationStatus ||
    state.dkimStatus !== row.dkimStatus ||
    state.mailFromStatus !== row.mailFromStatus
  );
}

function identityFields(state: DomainIdentityState) {
  return {
    verificationStatus: state.verificationStatus,
    dkimStatus: state.dkimStatus,
    mailFromDomain: state.mailFromDomain,
    mailFromStatus: state.mailFromStatus,
    dnsRecordsJson: JSON.stringify(state.records),
  };
}

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
    // Least-recently-checked first, never-checked rows leading. Once there are
    // more pending domains than one sweep can read, the batch rotates instead of
    // re-reading the same DOMAIN_RECHECK_MAX rows forever and starving the tail.
    .orderBy(sql`${sendingDomains.lastCheckedAt} asc nulls first`)
    .limit(DOMAIN_RECHECK_MAX);

  let verified = 0;
  for (const domain of pending) {
    try {
      const state = await fetchIdentity(domain.domain);
      const now = nowIso();
      // Persist on any meaningful change: verification/DKIM (the gate) or the
      // optional Return-Path (mailFromStatus), so the setup guide reflects the
      // latest SES state even when only deliverability moved.
      if (identityMoved(domain, state)) {
        await db
          .update(sendingDomains)
          .set({ ...identityFields(state), lastCheckedAt: now, updatedAt: now })
          .where(eq(sendingDomains.id, domain.id));
        if (state.verificationStatus === "verified") verified += 1;
      } else {
        // Nothing moved, but the read still happened. Stamp it so the ordering
        // above advances to the rows queued behind this one.
        await db
          .update(sendingDomains)
          .set({ lastCheckedAt: now })
          .where(eq(sendingDomains.id, domain.id));
      }
    } catch (err) {
      // One bad domain must not abort the sweep.
      console.error(`[cron] domain re-check failed for ${domain.domain}:`, err);
    }
  }
  return verified;
}

// Re-check domains SES has ALREADY verified.
//
// recheckPendingDomains only ever looks at rows still waiting to verify, so
// until this pass existed nothing read a domain again once it went green. SES
// withdraws verification when the DKIM CNAMEs stop resolving, and revokes the
// custom Return-Path when its MX disappears: a DNS host migration, a zone
// tidy-up, an expired registration. Both regressions are silent. Losing the
// Return-Path keeps mail flowing but drops SES back to a shared amazonses.com
// return address (BehaviorOnMxFailure=USE_DEFAULT_VALUE), costing SPF alignment
// and inbox placement; losing DKIM stops mail from that domain outright. The
// first thing a customer would otherwise notice is a campaign that failed.
//
// AWS does report both, as account-wide Health events, but those land with the
// operator of the AWS account and carry no tenant, so the identity's own SES
// state is the signal we act on.
//
// A patrol, not a poll: rows read within VERIFIED_RECHECK_EVERY_HOURS are
// skipped and the rest taken least-recently-checked first, so the pass costs
// nothing once every domain is current, and a regression surfaces within roughly
// the recheck interval.
export async function recheckVerifiedDomains(
  db: Db,
  fetchIdentity: DomainIdentityFetcher | null,
): Promise<number> {
  if (!fetchIdentity) return 0; // SES not configured in this process

  const due = new Date(Date.now() - VERIFIED_RECHECK_EVERY_HOURS * 3600_000).toISOString();
  const rows = await db
    .select()
    .from(sendingDomains)
    .where(
      and(
        eq(sendingDomains.verificationStatus, "verified"),
        eq(sendingDomains.provider, "ses"),
        // An admin override exists precisely because SES is not the truth for
        // that row (testing, a manual rescue), so polling it would only produce
        // noise and a notification nobody can act on.
        eq(sendingDomains.adminOverrideVerified, false),
        or(isNull(sendingDomains.lastCheckedAt), lt(sendingDomains.lastCheckedAt, due)),
      ),
    )
    .orderBy(sql`${sendingDomains.lastCheckedAt} asc nulls first`)
    .limit(VERIFIED_RECHECK_MAX);

  // One lookup per account rather than per domain: an account with several
  // domains regressing at once (one DNS zone going away takes them all) would
  // otherwise re-read the same account row for each.
  const accountCache = new Map<string, Account | undefined>();
  const accountFor = async (accountId: string): Promise<Account | undefined> => {
    if (!accountCache.has(accountId)) {
      accountCache.set(
        accountId,
        await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) }),
      );
    }
    return accountCache.get(accountId);
  };

  let regressions = 0;
  for (const domain of rows) {
    try {
      const state = await fetchIdentity(domain.domain);
      const now = nowIso();

      if (!identityMoved(domain, state)) {
        await db
          .update(sendingDomains)
          .set({ lastCheckedAt: now })
          .where(eq(sendingDomains.id, domain.id));
        continue;
      }

      // Claim the transition on the values we read. The notification below is
      // the user-visible half of this write, so a concurrent sweep that already
      // applied the same regression must not raise it a second time.
      const claimed = await db
        .update(sendingDomains)
        .set({ ...identityFields(state), lastCheckedAt: now, updatedAt: now })
        .where(
          and(
            eq(sendingDomains.id, domain.id),
            eq(sendingDomains.verificationStatus, domain.verificationStatus),
            eq(sendingDomains.mailFromStatus, domain.mailFromStatus),
          ),
        )
        .returning({ id: sendingDomains.id });
      if (claimed.length === 0) continue;

      const lostVerification = state.verificationStatus !== "verified";
      // Only a Return-Path that WAS live can be lost. A domain that never
      // published the MX is not regressing, it just never finished the optional
      // step, and the setup guide already says so in place.
      const lostReturnPath =
        !lostVerification &&
        domain.mailFromStatus === "success" &&
        state.mailFromStatus !== "success";
      // Neither: DKIM detail moved while the domain stayed verified, or the
      // Return-Path came up. Recorded above, nothing to tell anyone.
      if (!lostVerification && !lostReturnPath) continue;
      regressions += 1;

      const account = await accountFor(domain.accountId);
      if (!account) continue;
      // Deliberately not throttled per kind: the claimed transition above is
      // already the exactly-once guard, and a throttle would silently swallow a
      // second domain breaking in the same window, which is the case that most
      // needs saying.
      await notifyAccount(
        db,
        account,
        lostVerification
          ? {
              kind: "domain_verification_lost",
              title: `Sending from ${domain.domain} has stopped working`,
              body:
                "Amazon no longer verifies this domain, which almost always means its DKIM records were changed or removed at your DNS host. " +
                "Email from this address will fail until they are back in place.",
              ctaHref: `/domains/${domain.id}`,
              ctaLabel: "Check the DNS records",
            }
          : {
              kind: "domain_return_path_lost",
              title: `${domain.domain} lost its Return-Path record`,
              body:
                `Your email still goes out, but the MX record for ${domain.mailFromDomain ?? `send.${domain.domain}`} stopped answering, ` +
                "so bounces fall back to a shared Amazon address. That weakens SPF alignment and can push your mail to spam.",
              ctaHref: `/domains/${domain.id}`,
              ctaLabel: "Check the DNS records",
            },
      );
    } catch (err) {
      // One bad domain must not abort the sweep.
      console.error(`[cron] verified domain re-check failed for ${domain.domain}:`, err);
    }
  }
  return regressions;
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

// The daily branch is gated by a last-run marker (a `cron_daily` job_logs row)
// instead of a wall-clock window: a fixed 03:00–03:15 window silently skips the
// whole day whenever the worker happens to be down or the sweep job is delayed
// past the window — a marker self-heals on the very next sweep.
const DAILY_EVERY_MS = 20 * 60 * 60 * 1000;
async function dailyChecksDue(db: Db, now: Date): Promise<boolean> {
  const [last] = await db
    .select({ createdAt: jobLogs.createdAt })
    .from(jobLogs)
    .where(eq(jobLogs.jobType, "cron_daily"))
    .orderBy(desc(jobLogs.createdAt))
    .limit(1);
  if (!last) return true;
  return now.getTime() - Date.parse(last.createdAt) > DAILY_EVERY_MS;
}

// Fallback usage reset. The Clerk `subscriptionItem.active` webhook is the
// primary period source (it zeroes usage and advances the marker when a new
// period starts — see applySubscriptionEvent); this cron only catches accounts
// whose period elapsed without a webhook arriving. It runs on EVERY sweep: the
// WHERE below already makes it a no-op for accounts whose period hasn't ended,
// and the marker push-forward prevents double resets — gating it to a calendar
// window (the old behavior: day 1, 03:00–03:15 UTC) meant one missed window
// blocked a webhook-less account's sending for up to a month.
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
// BullMQ repeatable job (worker/index.ts); `now` is injected so the time-based
// branches stay testable.
//
// Stages run isolated: one failing stage (a poison campaign row, a flaky
// dependency) must not silently disable the rest of the maintenance surface.
// Errors are collected, logged to job_logs (queryable), and re-thrown at the
// end so BullMQ still surfaces the failed sweep.
export async function runScheduledSweeps(deps: CronDeps, now: Date = new Date()): Promise<void> {
  const { db, queue } = deps;
  const errors: string[] = [];
  const stage = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
    try {
      return await fn();
    } catch (err) {
      console.error(`[cron] stage ${name} failed:`, err);
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
      return undefined;
    }
  };

  const failed = (await stage("fail_stuck", () => failStuckRecipients(db))) ?? 0;
  const transactional = (await stage("transactional", () => sweepTransactionalEmails(db, queue, now))) ?? {
    failed: 0,
    requeued: 0,
  };
  // Reset before resume so a period rollover this sweep un-pauses quota-paused
  // campaigns in the same run.
  const usageReset = (await stage("usage_reset", () => resetMonthlyUsage(db, now))) ?? 0;
  const released = (await stage("release_due", () => releaseDueCampaigns(db, queue, now))) ?? 0;
  const resumed = (await stage("resume_paused", () => resumePausedCampaigns(db, queue, now))) ?? 0;
  await stage("reconcile", () => reconcileSendingCampaigns(db, queue));
  const rescued = (await stage("rescue_pipeline", () => rescueStuckPipelineCampaigns(db, queue, now))) ?? 0;
  const webhooks = (await stage("webhook_deliveries", () => sweepWebhookDeliveries(db, queue, now))) ?? 0;
  const automation = (await stage("automations", () => sweepAutomationEnrollments(db, queue, now))) ?? {
    failed: 0,
    requeued: 0,
  };

  // SES re-check only when this process has SES configured. Two passes: domains
  // still working towards verification, and (far more slowly) domains that got
  // there and could have quietly regressed since.
  const region = process.env.AWS_REGION;
  const fetchIdentity = region ? (domain: string) => getDomainIdentity(domain, region) : null;
  const domainsVerified = (await stage("domain_recheck", () => recheckPendingDomains(db, fetchIdentity))) ?? 0;
  const domainsRegressed =
    (await stage("domain_recheck_verified", () => recheckVerifiedDomains(db, fetchIdentity))) ?? 0;

  const isDaily =
    (await stage("daily", async () => {
      if (!(await dailyChecksDue(db, now))) return false;
      await dailyHealthChecks(db);
      await pruneTransactionalBodies(db, now);
      await pruneWebhookDeliveries(db, now);
      await pruneJobLogs(db, now);
      await logJob(db, { jobType: "cron_daily", status: "completed" });
      return true;
    })) ?? false;

  await logJob(db, {
    jobType: "cron",
    status: errors.length > 0 ? "failed" : "completed",
    error: errors.length > 0 ? errors.join("; ") : undefined,
    payload: {
      stuckFailed: failed,
      transactionalFailed: transactional.failed,
      transactionalRequeued: transactional.requeued,
      released,
      resumed,
      rescued,
      usageReset,
      domainsVerified,
      domainsRegressed,
      webhooks,
      automationFailed: automation.failed,
      automationRequeued: automation.requeued,
      daily: isDaily,
    },
  });

  if (errors.length > 0) {
    throw new Error(`cron sweep stages failed: ${errors.join("; ")}`);
  }
}
