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
} from "../../db/schema";
import { canonicalizeEmail } from "../../lib/csv";
import { newId, nowIso } from "../../lib/ids";
import { logJob } from "../../lib/job-log";
import type { EmailProvider } from "../../email/provider";
import { renderCampaignEmail } from "../../services/render";
import { signUnsubscribeToken, unsubscribeUrl } from "../../services/unsubscribe";
import { getSuppressedEmails, addSuppression } from "../../services/suppression";
import { enforceAccountHealth } from "../../services/health";
import type { JobQueue } from "../messages";

export type SendBatchDeps = {
  db: Db;
  jobsQueue: JobQueue;
  emailProvider: EmailProvider;
  appUrl: string;
  unsubscribeSecret: string;
};

async function pauseCampaign(db: Db, campaignId: string, reason: string): Promise<void> {
  await db
    .update(campaigns)
    .set({ status: "paused", pausedReason: reason, updatedAt: nowIso() })
    .where(and(eq(campaigns.id, campaignId), eq(campaigns.status, "sending")));
}

// Returns claimed rows back to pending. Only valid for rows whose email was
// NOT handed to the provider.
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

export async function sendCampaignBatch(
  message: { campaignId: string; accountId: string; batchSize: number },
  deps: SendBatchDeps,
): Promise<void> {
  const { db, jobsQueue } = deps;

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
    await pauseCampaign(db, campaign.id, account.pausedReason ?? "Account sending is disabled.");
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
  // limit. `granted` is how much *this* worker actually won (new count minus
  // old, captured via a CTE because RETURNING only sees post-update values).
  // The read above is advisory only; correctness rests on this statement.
  const claimCount = Number(await reserveQuota(db, account.id, message.batchSize));

  if (claimCount <= 0) {
    await pauseCampaign(db, campaign.id, "Monthly email limit was reached.");
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
  // pending rows instead of two workers racing for the same ids. (Under D1's
  // single writer this was implicit; on Postgres it must be explicit.)
  const claimed = await db
    .update(campaignRecipients)
    .set({ status: "sending", lockedAt: nowIso(), updatedAt: nowIso() })
    .where(
      inArray(
        campaignRecipients.id,
        sql`(SELECT id FROM campaign_recipients WHERE campaign_id = ${campaign.id} AND status = 'pending' ORDER BY created_at LIMIT ${claimCount} FOR UPDATE SKIP LOCKED)`,
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
        batchSize: message.batchSize,
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
        await db
          .update(campaigns)
          .set({ status: "sent", sentAt: nowIso(), updatedAt: nowIso() })
          .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "sending")));
        await enforceAccountHealth(db, campaign.accountId);
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
// SEND_BATCH_SIZE emails, so one multi-row insert per flush is plenty.
const EVENT_INSERT_CHUNK = 100;

// Atomically reserves up to `amount` units of monthly send quota and returns
// how many were actually granted (0 when the account is at its limit). The CTE
// captures the pre-update count under a row lock so `granted` is the true
// new-minus-old delta — RETURNING on its own only exposes post-update values.
// Doing the read-and-conditional-increment in one statement is what bounds the
// total across concurrent workers by the limit instead of by a stale read.
async function reserveQuota(db: Db, accountId: string, amount: number): Promise<number> {
  const rows = await db.execute<{ granted: number }>(sql`
    WITH prev AS (
      SELECT monthly_email_sent_count AS old_count, monthly_email_limit AS lim
      FROM accounts WHERE id = ${accountId} FOR UPDATE
    )
    UPDATE accounts
    SET monthly_email_sent_count = LEAST(prev.old_count + ${amount}, prev.lim),
        updated_at = ${nowIso()}
    FROM prev
    WHERE accounts.id = ${accountId}
    RETURNING LEAST(prev.old_count + ${amount}, prev.lim) - prev.old_count AS granted
  `);
  const row = (Array.isArray(rows) ? rows[0] : (rows as { rows?: { granted: number }[] }).rows?.[0]) as
    | { granted: number }
    | undefined;
  return Number(row?.granted ?? 0);
}

// Gives `amount` units of reserved quota back to the account. Quota is reserved
// atomically up front (see sendCampaignBatch); rows that turn out not to send —
// suppressed, failed, rate-limited, or claimed-but-rolled-back — release their
// slice so the counter converges on the number of emails actually sent.
async function releaseReservation(db: Db, accountId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  await db
    .update(accounts)
    .set({
      // GREATEST guards against the counter dipping below zero if reservations
      // and releases ever interleave unexpectedly.
      monthlyEmailSentCount: sql`GREATEST(${accounts.monthlyEmailSentCount} - ${amount}, 0)`,
      updatedAt: nowIso(),
    })
    .where(eq(accounts.id, accountId));
}

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
    await db.insert(emailEvents).values(events.slice(i, i + EVENT_INSERT_CHUNK));
  }
}

async function sendToClaimed(
  claimed: CampaignRecipient[],
  account: { id: string; name: string; companyAddress: string | null },
  campaign: Campaign,
  deps: SendBatchDeps,
): Promise<{ sent: number; failed: number; skipped: number }> {
  const { db, emailProvider } = deps;

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

  // Accumulated in memory and flushed once per exit point (see flushBatchWrites).
  const pendingEvents: (typeof emailEvents.$inferInsert)[] = [];

  let sent = 0;
  let failed = 0;
  let skipped = 0;

  for (let i = 0; i < claimed.length; i++) {
    const recipient = claimed[i];

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

    const rendered = renderCampaignEmail({
      campaign,
      subscriber: {
        email: recipient.email,
        firstName: subscriber?.firstName,
        lastName: subscriber?.lastName,
      },
      companyName: account.name,
      companyAddress: account.companyAddress,
      unsubscribeUrl: unsubUrl,
    });

    const result = await emailProvider.send({
      accountId: account.id,
      campaignId: campaign.id,
      recipientId: recipient.id,
      fromEmail: campaign.fromEmail,
      fromName: campaign.fromName,
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
    } else if (result.status === "suppressed") {
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
    } else if (result.status === "rate_limited") {
      // The email was not sent — safe to return this row and the rest of the
      // batch to pending, then pause the campaign for a later resume.
      const rest = claimed.slice(i).map((r) => r.id);
      await unlockRecipients(db, rest);
      const reason =
        result.error === "E_DAILY_LIMIT_EXCEEDED"
          ? "Provider daily sending limit reached. Resume tomorrow."
          : "Provider rate limit hit. Resume shortly.";
      await pauseCampaign(db, campaign.id, reason);
      await flushBatchWrites(db, account.id, claimed.length, sent, pendingEvents);
      return { sent, failed, skipped };
    } else if (result.error?.startsWith("E_SENDER_NOT_VERIFIED")) {
      const rest = claimed.slice(i).map((r) => r.id);
      await unlockRecipients(db, rest);
      await db
        .update(sendingDomains)
        .set({ verificationStatus: "failed", updatedAt: nowIso() })
        .where(eq(sendingDomains.id, campaign.sendingDomainId));
      await pauseCampaign(db, campaign.id, "Sender domain is not verified with the provider.");
      await flushBatchWrites(db, account.id, claimed.length, sent, pendingEvents);
      return { sent, failed, skipped };
    } else {
      const now = nowIso();
      await db
        .update(campaignRecipients)
        .set({ status: "failed", error: result.error ?? "unknown error", updatedAt: now })
        .where(eq(campaignRecipients.id, recipient.id));
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
    }
  }

  await flushBatchWrites(db, account.id, claimed.length, sent, pendingEvents);
  return { sent, failed, skipped };
}
