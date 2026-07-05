import { and, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import {
  accounts,
  campaignRecipients,
  campaigns,
  emailEvents,
  sendingDomains,
  subscribers,
  type Campaign,
  type CampaignRecipient,
  type PausedCode,
} from "../../db/schema";
import { canonicalizeEmail } from "../../lib/csv";
import { newId, nowIso } from "../../lib/ids";
import { logJob } from "../../lib/job-log";
import { logger } from "../../lib/logger";
import type { EmailProvider } from "../../email/provider";
import {
  E_ACCOUNT_SUSPENDED,
  E_DAILY_LIMIT_EXCEEDED,
  E_SENDER_NOT_VERIFIED,
  E_SENDING_MISCONFIGURED,
} from "../../email/ses";
import { renderCampaignEmail, extractTrackableLinks } from "../../services/render";
import { safeParseTheme } from "../../lib/theme";
import { signUnsubscribeToken, unsubscribeUrl } from "../../services/unsubscribe";
import {
  signOpenToken,
  openTrackingUrl,
  signClickToken,
  clickTrackingUrl,
} from "../../services/open-tracking";
import { getSuppressedEmails, addSuppression } from "../../services/suppression";
import { enforceAccountHealth } from "../../services/health";
import { notifyCampaignPaused, notifyCampaignSent } from "../../services/notifications";
import { releaseReservation, reserveQuota } from "../../services/quota";
import { MAX_SEND_BATCH_SIZE, SEND_BATCH_SIZE, type JobQueue } from "../messages";

export type SendBatchDeps = {
  db: Db;
  jobsQueue: JobQueue;
  emailProvider: EmailProvider;
  appUrl: string;
  unsubscribeSecret: string;
  // Graceful-shutdown signal (worker/index.ts flips it on SIGTERM). Checked
  // between recipients: the untouched remainder is returned to pending so a
  // deploy never leaves rows to be swept to failed.
  shouldAbort?: () => boolean;
};

// Pauses the campaign with a machine-readable code (what the cron sweep keys
// auto-resume on) and a human-facing reason. Returns whether THIS call claimed
// the sending→paused transition — the caller only notifies when it did, so a
// pause never notifies twice.
async function pauseCampaign(
  db: Db,
  campaignId: string,
  code: PausedCode,
  reason: string,
): Promise<boolean> {
  const claimed = await db
    .update(campaigns)
    .set({ status: "paused", pausedReason: reason, pausedCode: code, updatedAt: nowIso() })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "sending")))
    .returning({ id: campaigns.id });
  return claimed.length > 0;
}

// Pause + notify in one step for pauses that happen mid-send.
async function pauseAndNotify(
  db: Db,
  campaign: { id: string; name: string; accountId: string },
  code: PausedCode,
  reason: string,
): Promise<void> {
  const claimed = await pauseCampaign(db, campaign.id, code, reason);
  if (claimed) {
    await notifyCampaignPaused(db, campaign, code, reason);
  }
}

// Returns claimed rows back to pending. Only valid for rows whose email was
// NOT handed to the provider (the status guard also makes it a no-op for rows
// the stuck-lock sweep already flipped to failed — those must never resurrect).
async function unlockRecipients(db: Db, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    await db
      .update(campaignRecipients)
      .set({ status: "pending", lockedAt: null, updatedAt: nowIso() })
      .where(
        and(inArray(campaignRecipients.id, chunk), eq(campaignRecipients.status, "sending")),
      );
  }
}

// Re-stamps lockedAt on the not-yet-sent remainder of a live batch so the cron
// stuck-lock sweep (which fails rows locked >15 min ago) can never mistake a
// slow-but-alive batch for a crashed one and fail rows we're about to send.
async function refreshLocks(db: Db, ids: string[]): Promise<void> {
  const now = nowIso();
  for (let i = 0; i < ids.length; i += 80) {
    const chunk = ids.slice(i, i + 80);
    await db
      .update(campaignRecipients)
      .set({ lockedAt: now, updatedAt: now })
      .where(
        and(inArray(campaignRecipients.id, chunk), eq(campaignRecipients.status, "sending")),
      );
  }
}

export async function sendCampaignBatch(
  message: { campaignId: string; accountId: string; batchSize: number },
  deps: SendBatchDeps,
): Promise<void> {
  const { db, jobsQueue } = deps;

  // Server-side clamp: batchSize arrives in the queue message (a trust
  // boundary — stale producers, operator replays), and an oversized batch
  // would outrun the stuck-lock window while a NaN/0 would wrongly pause the
  // campaign as "limit reached" below.
  const batchSize = Number.isFinite(message.batchSize)
    ? Math.min(MAX_SEND_BATCH_SIZE, Math.max(1, Math.floor(message.batchSize)))
    : SEND_BATCH_SIZE;

  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, message.accountId),
  });
  const campaign = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, message.campaignId), eq(campaigns.accountId, message.accountId)),
  });

  // Idempotency: only a campaign in "sending" sends. Anything else (sent,
  // paused, blocked, …) means this message is stale — drop it.
  if (!account || !campaign || campaign.status !== "sending") {
    await logJob(db, {
      jobType: "send_campaign_batch",
      entityType: "campaign",
      entityId: message.campaignId,
      status: "skipped",
      error: campaign ? `campaign status is ${campaign.status}` : "not found",
    });
    return;
  }

  if (account.subscriptionStatus !== "active" || !account.sendingEnabled) {
    await pauseAndNotify(
      db,
      campaign,
      "account",
      account.pausedReason ?? "Account sending is disabled.",
    );
    await logJob(db, {
      jobType: "send_campaign_batch",
      entityType: "campaign",
      entityId: campaign.id,
      status: "skipped",
      error: "account not eligible to send",
    });
    return;
  }

  // Atomically *reserve* quota before claiming any rows. The counter is bumped
  // by up to batchSize in a single conditional statement that can never push
  // the count past the limit (`LEAST(count + n, limit)`), so two concurrent
  // BullMQ workers reading the same near-exhausted account can only ever divide
  // the remaining headroom between them — their reservations sum to at most the
  // limit (see services/quota.ts). The read above is advisory only; correctness
  // rests on that statement.
  const claimCount = Number(await reserveQuota(db, account.id, batchSize));

  if (claimCount <= 0) {
    await pauseAndNotify(
      db,
      campaign,
      "quota",
      "Monthly email limit was reached. Sending resumes automatically if quota frees up, or upgrade your plan to send more.",
    );
    await logJob(db, {
      jobType: "send_campaign_batch",
      entityType: "campaign",
      entityId: campaign.id,
      status: "skipped",
      error: "monthly email limit reached",
    });
    return;
  }

  // Atomic claim: flip up to `claimCount` pending rows to "sending" in one
  // statement. A concurrent or retried batch can never claim the same row
  // twice, which is what makes retries duplicate-free. `FOR UPDATE SKIP LOCKED`
  // on the inner SELECT is what makes this safe under *true* concurrency
  // (multiple BullMQ workers): each worker locks and claims a disjoint set of
  // pending rows instead of two workers racing for the same ids. No ORDER BY:
  // recipients of a campaign share a single created_at (generate-recipients
  // stamps the whole audience with one timestamp), so ordering bought nothing
  // and forced Postgres to sort every remaining pending row on every claim.
  const claimed = await db
    .update(campaignRecipients)
    .set({ status: "sending", lockedAt: nowIso(), updatedAt: nowIso() })
    .where(
      inArray(
        campaignRecipients.id,
        sql`(SELECT id FROM campaign_recipients WHERE campaign_id = ${campaign.id} AND status = 'pending' LIMIT ${claimCount} FOR UPDATE SKIP LOCKED)`,
      ),
    )
    .returning();

  // Release the slice of the reservation we couldn't fill with real rows (e.g.
  // fewer pending recipients than quota allowed). This keeps the counter equal
  // to actual reserved sends; the per-send reconciliation below handles rows
  // that are claimed but never sent (suppressed/failed/rate-limited).
  if (claimed.length < claimCount) {
    await releaseReservation(db, account.id, claimCount - claimed.length);
  }

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  if (claimed.length > 0) {
    const result = await sendToClaimed(claimed, account, campaign, deps);
    sent = result.sent;
    failed = result.failed;
    skipped = result.skipped;
  }

  // Decide what happens next based on fresh state (sends above may have
  // paused the campaign).
  const freshCampaign = await db.query.campaigns.findFirst({
    where: eq(campaigns.id, campaign.id),
  });
  if (freshCampaign?.status === "sending") {
    const [{ pending }] = await db
      .select({ pending: sql<number>`count(*)`.as("pending") })
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.campaignId, campaign.id),
          eq(campaignRecipients.status, "pending"),
        ),
      );

    if (Number(pending) > 0) {
      await jobsQueue.send({
        type: "send_campaign_batch",
        campaignId: campaign.id,
        accountId: campaign.accountId,
        batchSize,
      });
    } else {
      const [{ inFlight }] = await db
        .select({ inFlight: sql<number>`count(*)`.as("inFlight") })
        .from(campaignRecipients)
        .where(
          and(
            eq(campaignRecipients.campaignId, campaign.id),
            eq(campaignRecipients.status, "sending"),
          ),
        );
      // Rows stuck in "sending" belong to a concurrent batch or a crashed
      // one; the cron sweep resolves them. Only finish when none remain.
      if (Number(inFlight) === 0) {
        const completed = await db
          .update(campaigns)
          .set({ status: "sent", sentAt: nowIso(), updatedAt: nowIso() })
          .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "sending")))
          .returning({ id: campaigns.id });
        await enforceAccountHealth(db, campaign.accountId);
        // Notify exactly once — only the batch whose UPDATE actually flipped the
        // status from "sending" to "sent" owns the completion.
        if (completed.length > 0) {
          await notifyCampaignSent(db, campaign);
        }
      }
    }
  }

  await logJob(db, {
    jobType: "send_campaign_batch",
    entityType: "campaign",
    entityId: campaign.id,
    status: "completed",
    payload: { claimed: claimed.length, sent, failed, skipped },
  });
}

// Postgres bound-param ceiling is 65535; a single batch sends at most
// MAX_SEND_BATCH_SIZE emails, so one multi-row insert per flush is plenty.
const EVENT_INSERT_CHUNK = 100;

// Re-stamp locks on the remainder when the batch has been running this long
// since the claim / last refresh (see refreshLocks). Time-based, not
// count-based: a fast batch never pays for refreshes, while a slow one (SES
// throttling, network latency) keeps its locks comfortably fresher than the
// sweep's 15-minute stuck-lock cutoff.
const LOCK_REFRESH_MS = 5 * 60 * 1000;

// Stop the batch when this many consecutive recipients fail with the same
// error. A repeating identical error is a campaign-global problem (unknown
// config/identity/provider issue), and grinding on would burn the entire
// audience to terminal `failed` — pausing keeps the rest recoverable.
const CIRCUIT_BREAKER_THRESHOLD = 10;

// Flushes the per-batch bookkeeping that we deliberately do NOT write once per
// email: it reconciles the up-front quota reservation against what was actually
// sent (releasing the unsent slice) and bulk-inserts the event rows.
//
// Crash-window tradeoff: each recipient's "sent" status (with its provider
// message id) is still written immediately, so a crash never re-sends — a
// retried batch only re-claims "pending" rows. If a crash happens between the
// last send and this flush, the reservation is *not* released, so the counter
// over-counts by at most one batch and some "sent" events are missing. Erring
// toward over-counting (never under) is the safe side of a billing/abuse
// boundary, and far cheaper than a hot-row UPDATE per email.
async function flushBatchWrites(
  db: Db,
  accountId: string,
  reservedCount: number,
  sentCount: number,
  events: (typeof emailEvents.$inferInsert)[],
): Promise<void> {
  await releaseReservation(db, accountId, reservedCount - sentCount);
  for (let i = 0; i < events.length; i += EVENT_INSERT_CHUNK) {
    // Dedupe-safe like the SNS-webhook insert: the unique index on
    // (providerMessageId, eventType) turns any replayed event into a no-op
    // instead of failing the whole flush.
    await db
      .insert(emailEvents)
      .values(events.slice(i, i + EVENT_INSERT_CHUNK))
      .onConflictDoNothing();
  }
}

async function sendToClaimed(
  claimed: CampaignRecipient[],
  account: { id: string; name: string; companyAddress: string | null },
  campaign: Campaign,
  deps: SendBatchDeps,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const { db, emailProvider } = deps;

  // Accumulated in memory and flushed exactly once, in the finally below, so
  // every exit path — return, circuit-break, transient throw, unexpected
  // throw — reconciles the quota reservation and persists the event rows.
  const pendingEvents: (typeof emailEvents.$inferInsert)[] = [];

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  // Crash-boundary bookkeeping for the catch below: `index` is the recipient
  // being worked on; `handedOff` is true from the moment the provider call
  // starts until that recipient's terminal status row is written. A row whose
  // email may be at the provider must never be returned to pending.
  let index = 0;
  let handedOff = false;
  let threw = false;

  try {
    // Re-check suppression at send time — someone may have unsubscribed since
    // recipients were generated.
    const suppressed = await getSuppressedEmails(
      db,
      account.id,
      claimed.map((r) => r.email),
    );

    const subscriberIds = claimed.map((r) => r.subscriberId).filter((id): id is string => !!id);
    const subscriberRows =
      subscriberIds.length > 0
        ? await db.select().from(subscribers).where(inArray(subscribers.id, subscriberIds))
        : [];
    const subscriberById = new Map(subscriberRows.map((s) => [s.id, s]));

    // The campaign body is identical for every recipient, so its trackable links
    // are extracted once; only the per-recipient signed token differs below.
    const trackableLinks = deps.appUrl ? extractTrackableLinks(campaign.htmlBody) : [];

    // The global theme is the same for every recipient — parse it once (null →
    // DEFAULT_THEME inside renderCampaignEmail).
    const theme = safeParseTheme(campaign.themeJson);

    let consecutiveFailed = 0;
    let lastFailError: string | null = null;
    let lastLockRefresh = Date.now();

    for (index = 0; index < claimed.length; index++) {
      const recipient = claimed[index];

      // Graceful shutdown (deploy/restart): nothing for this recipient has been
      // handed off yet, so the remainder safely returns to pending; the caller
      // still enqueues the follow-up batch that drains it after the restart.
      if (deps.shouldAbort?.()) {
        await unlockRecipients(db, claimed.slice(index).map((r) => r.id));
        break;
      }

      // Keep the stuck-lock sweep from failing rows of a slow-but-live batch.
      if (Date.now() - lastLockRefresh > LOCK_REFRESH_MS) {
        await refreshLocks(db, claimed.slice(index).map((r) => r.id));
        lastLockRefresh = Date.now();
      }

      if (suppressed.has(canonicalizeEmail(recipient.email))) {
        await db
          .update(campaignRecipients)
          .set({ status: "skipped", error: "suppressed", updatedAt: nowIso() })
          .where(eq(campaignRecipients.id, recipient.id));
        skipped++;
        continue;
      }

      const subscriber = recipient.subscriberId
        ? subscriberById.get(recipient.subscriberId)
        : undefined;

      const token = await signUnsubscribeToken(
        {
          accountId: account.id,
          subscriberId: recipient.subscriberId ?? "",
          email: recipient.email,
          campaignId: campaign.id,
          campaignRecipientId: recipient.id,
        },
        deps.unsubscribeSecret,
      );
      const unsubUrl = unsubscribeUrl(deps.appUrl, token);

      // Build the per-recipient open-tracking pixel URL. Skip it when no public
      // app URL is configured (the pixel needs an absolute, reachable href to be
      // worth anything).
      let openUrl: string | null = null;
      if (deps.appUrl) {
        const openToken = await signOpenToken(
          {
            accountId: account.id,
            campaignId: campaign.id,
            campaignRecipientId: recipient.id,
            email: recipient.email,
          },
          deps.unsubscribeSecret,
        );
        openUrl = openTrackingUrl(deps.appUrl, openToken);
      }

      // Per-recipient click-tracking redirects: one signed token per distinct
      // content link, carrying that link's real destination so the redirect is
      // tamper-proof. Keyed by the exact href in the rendered HTML.
      let linkTracking: Record<string, string> | null = null;
      if (deps.appUrl && trackableLinks.length > 0) {
        linkTracking = {};
        for (const link of trackableLinks) {
          const clickToken = await signClickToken(
            {
              accountId: account.id,
              campaignId: campaign.id,
              campaignRecipientId: recipient.id,
              email: recipient.email,
              url: link.url,
            },
            deps.unsubscribeSecret,
          );
          linkTracking[link.raw] = clickTrackingUrl(deps.appUrl, clickToken);
        }
      }

      const rendered = renderCampaignEmail({
        campaign,
        theme,
        subscriber: {
          email: recipient.email,
          firstName: subscriber?.firstName,
          lastName: subscriber?.lastName,
          attributes: subscriber?.attributes,
        },
        companyName: account.name,
        companyAddress: account.companyAddress,
        unsubscribeUrl: unsubUrl,
        openTrackingUrl: openUrl,
        linkTracking,
      });

      handedOff = true;
      const result = await emailProvider.send({
        accountId: account.id,
        campaignId: campaign.id,
        recipientId: recipient.id,
        fromEmail: campaign.fromEmail,
        fromName: campaign.fromName,
        replyTo: campaign.replyTo ?? undefined,
        toEmail: recipient.email,
        subject: rendered.subject,
        html: rendered.html,
        text: rendered.text,
        headers: {
          "List-Unsubscribe": `<${unsubUrl}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
          "X-Campaign-ID": campaign.id,
          "X-Account-ID": account.id,
          "X-Recipient-ID": recipient.id,
        },
      });

      if (result.status === "sent") {
        const now = nowIso();
        await db
          .update(campaignRecipients)
          .set({
            status: "sent",
            sentAt: now,
            providerMessageId: result.messageId,
            provider: result.provider,
            error: null,
            updatedAt: now,
          })
          .where(eq(campaignRecipients.id, recipient.id));
        handedOff = false;
        // Usage counter and event are flushed per batch, not per email.
        pendingEvents.push({
          id: newId("evt"),
          accountId: account.id,
          campaignId: campaign.id,
          campaignRecipientId: recipient.id,
          eventType: "sent",
          email: recipient.email,
          provider: result.provider,
          providerMessageId: result.messageId,
          createdAt: now,
        });
        sent++;
        consecutiveFailed = 0;
        lastFailError = null;
      } else if (result.status === "suppressed") {
        handedOff = false; // provider rejected the address — nothing left
        await db
          .update(campaignRecipients)
          .set({ status: "skipped", error: result.error, updatedAt: nowIso() })
          .where(eq(campaignRecipients.id, recipient.id));
        await addSuppression(db, {
          accountId: account.id,
          email: recipient.email,
          reason: "provider_suppressed",
          source: "send_campaign_batch",
        });
        skipped++;
        consecutiveFailed = 0;
        lastFailError = null;
      } else if (result.status === "rate_limited") {
        // The provider rejected the request before sending — this recipient and
        // the rest of the batch are provably unsent, safe to return to pending.
        handedOff = false;
        await unlockRecipients(db, claimed.slice(index).map((r) => r.id));
        const err = result.error ?? "";
        let code: PausedCode = "rate_limit";
        let reason = "Provider rate limit hit. Sending resumes automatically within minutes.";
        if (err === E_DAILY_LIMIT_EXCEEDED) {
          code = "daily_limit";
          reason =
            "Provider daily sending limit reached. Sending resumes automatically once the daily window resets.";
        } else if (err.startsWith(E_ACCOUNT_SUSPENDED)) {
          code = "suspended";
          reason = "The email provider has suspended sending. Our team has been alerted.";
          // A provider-level suspension threatens every tenant — page ops.
          void logger.reportError(
            "SES account-level sending suspension detected mid-send",
            new Error(err),
            { campaignId: campaign.id, accountId: account.id },
          );
        } else if (err.startsWith(E_SENDING_MISCONFIGURED)) {
          code = "config";
          reason = "Sending is temporarily misconfigured on our side. Our team has been alerted.";
          void logger.reportError("SES sending misconfiguration detected mid-send", new Error(err), {
            campaignId: campaign.id,
            accountId: account.id,
          });
        }
        await pauseAndNotify(db, campaign, code, reason);
        return { sent, failed, skipped };
      } else if (result.status === "transient") {
        // The request provably never reached the provider (connection-phase
        // failure). Everything from this recipient on returns to pending, and
        // the thrown error hands retry/backoff to BullMQ — the retried job
        // re-claims exactly these rows. This is the documented THROW-on-
        // transient contract in messages.ts.
        handedOff = false;
        await unlockRecipients(db, claimed.slice(index).map((r) => r.id));
        throw new Error(`transient provider error, batch will retry: ${result.error}`);
      } else if (result.error?.startsWith(E_SENDER_NOT_VERIFIED)) {
        handedOff = false; // provider rejected — identity not verified
        await unlockRecipients(db, claimed.slice(index).map((r) => r.id));
        await db
          .update(sendingDomains)
          .set({ verificationStatus: "failed", updatedAt: nowIso() })
          .where(eq(sendingDomains.id, campaign.sendingDomainId));
        await pauseAndNotify(
          db,
          campaign,
          "config",
          "Sender domain is not verified with the provider.",
        );
        return { sent, failed, skipped };
      } else {
        const now = nowIso();
        await db
          .update(campaignRecipients)
          .set({ status: "failed", error: result.error ?? "unknown error", updatedAt: now })
          .where(eq(campaignRecipients.id, recipient.id));
        handedOff = false;
        pendingEvents.push({
          id: newId("evt"),
          accountId: account.id,
          campaignId: campaign.id,
          campaignRecipientId: recipient.id,
          eventType: "failed",
          email: recipient.email,
          provider: result.provider,
          payloadJson: JSON.stringify({ error: result.error }),
          createdAt: now,
        });
        failed++;

        // Circuit breaker: the same error over and over is campaign-global
        // (misconfiguration, unknown provider state) — stop before it burns
        // the whole audience to terminal failed.
        const errKey = result.error ?? "unknown error";
        consecutiveFailed = errKey === lastFailError ? consecutiveFailed + 1 : 1;
        lastFailError = errKey;
        if (consecutiveFailed >= CIRCUIT_BREAKER_THRESHOLD) {
          await unlockRecipients(db, claimed.slice(index + 1).map((r) => r.id));
          const reason = `Sending stopped after ${consecutiveFailed} identical failures. Our team has been alerted.`;
          void logger.reportError(
            "send circuit breaker tripped (repeated identical provider failures)",
            new Error(errKey),
            { campaignId: campaign.id, accountId: account.id, consecutiveFailed },
          );
          await pauseAndNotify(db, campaign, "error", reason);
          return { sent, failed, skipped };
        }
      }
    }

    return { sent, failed, skipped };
  } catch (err) {
    threw = true;
    // Unexpected throw (DB blip, render/token error, provider threw despite
    // its no-throw contract). Return to pending exactly the rows that were
    // provably never handed to the provider: everything after the current
    // recipient, plus the current one only if its provider call never started.
    // A handed-off row stays in "sending" — the stuck-lock sweep resolves it
    // to failed, the side that can never duplicate.
    const unlockFrom = handedOff ? index + 1 : index;
    try {
      await unlockRecipients(db, claimed.slice(unlockFrom).map((r) => r.id));
    } catch (unlockErr) {
      logger.error("failed to unlock batch remainder after send error", {
        campaignId: campaign.id,
        error: unlockErr instanceof Error ? unlockErr.message : String(unlockErr),
      });
    }
    throw err;
  } finally {
    // Single flush point for quota reconciliation + buffered events. If the
    // flush itself fails while another error is already propagating, keep the
    // original error (the quota over-count is the designed safe side).
    try {
      await flushBatchWrites(db, account.id, claimed.length, sent, pendingEvents);
    } catch (flushErr) {
      // The `threw` guard means this only surfaces the flush failure when no
      // error is already propagating — it can never mask the loop's exception.
      // eslint-disable-next-line no-unsafe-finally
      if (!threw) throw flushErr;
      logger.error("batch flush failed after send error (quota will over-count)", {
        campaignId: campaign.id,
        error: flushErr instanceof Error ? flushErr.message : String(flushErr),
      });
    }
  }
}
