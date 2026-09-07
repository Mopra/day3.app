import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, campaignRecipients, emailEvents, transactionalEmails } from "../db/schema";
import { nowIso } from "../lib/ids";
import { logger } from "../lib/logger";

export const BOUNCE_RATE_WARNING = 0.03;
export const BOUNCE_RATE_PAUSE = 0.04;
export const COMPLAINT_RATE_WARNING = 0.0005;
export const COMPLAINT_RATE_PAUSE = 0.0008;

// Below this many attempted sends, rates are too noisy to say anything at all.
export const MIN_ATTEMPTED_FOR_ENFORCEMENT = 50;

// A rate on its own is not evidence, and this is the half that was missing.
// The thresholds above are SES-grade, but SES applies them to SES-grade volume:
// at the enforcement floor of 50 attempted, 4% is *two* bounces and 0.08% rounds
// to *one* complaint. An ordinary B2B list bouncing at a true 1.5% clears
// 2-of-50 about 17% of the time, so roughly one in six clean small sends tripped
// the auto-pause, and a single "report spam" click did it outright.
//
// The auto-pause is also one-way: it flips `risk_status` to paused and only an
// operator can resume, so a false positive costs a support round-trip and tells
// a legitimate customer they look like a spammer. That asymmetry is why the bar
// belongs well above the noise rather than at it.
//
// So a pause needs the rate AND an absolute count of bad addresses behind it.
// The count is a crude confidence floor: the smallest possible pause becomes 20
// bounces (>=500 attempted) or 3 complaints (>=3750 attempted), volumes where
// the percentage is actually estimating something. AWS reasons the same way —
// SES opens a review at 5% bounce / 0.1% complaint but does not enforce against
// low-volume senders, because the rates are not meaningful there. An account
// genuinely mailing a purchased list blows through both counts on its first real
// send; an account sending 200 product notifications a fortnight never touches
// them, which is the population the rate-only rule was catching.
export const MIN_BOUNCED_FOR_PAUSE = 20;
export const MIN_COMPLAINED_FOR_PAUSE = 3;

// Reputation is judged over a TRAILING WINDOW of recent sends, not the account's
// lifetime. SES suspends on *recent* bounce/complaint rates, so a long good
// history must not dilute a current spike — an account that sent cleanly for
// months can still cross SES's thresholds today, and a lifetime average would
// react far too slowly. Env-tunable; defaults to 14 days.
export const HEALTH_WINDOW_DAYS = Math.max(1, Number(process.env.HEALTH_WINDOW_DAYS ?? "14"));

export type AccountHealth = {
  attempted: number;
  bounced: number;
  complained: number;
  bounceRate: number;
  complaintRate: number;
  status: "normal" | "warning" | "paused";
  reason?: string;
};

const COUNTED_TX_STATUSES = ["sent", "delivered", "bounced", "complained"] as const;

export async function computeAccountHealth(db: Db, accountId: string): Promise<AccountHealth> {
  // Only count emails SENT within the trailing window. `sent_at` is set on the
  // send and preserved through later delivered/bounced/complained transitions,
  // so this captures "of what we sent recently, how much went wrong" — the rate
  // SES actually reacts to. (ISO timestamps compare correctly against a tstz col.)
  const cutoff = new Date(Date.now() - HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db
    .select({
      status: campaignRecipients.status,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.accountId, accountId),
        gte(campaignRecipients.sentAt, cutoff),
        inArray(campaignRecipients.status, [
          "sent",
          "delivered",
          "bounced",
          "complained",
          "unsubscribed",
        ]),
      ),
    )
    .groupBy(campaignRecipients.status);

  // Transactional (API) sends count toward the SAME reputation. They must:
  // AWS judges one bounce rate for the whole SES account, and the API is the
  // path that skips campaign review entirely — an account mailing a harvested
  // list through POST /v1/emails would otherwise never trip the auto-pause.
  //
  // A message carries up to 50 recipients, so the denominator weighs
  // jsonb_array_length(to) rather than one row per message.
  const [txAttemptedRow] = await db
    .select({
      count: sql<number>`coalesce(sum(jsonb_array_length(${transactionalEmails.to})), 0)`.as(
        "count",
      ),
    })
    .from(transactionalEmails)
    .where(
      and(
        eq(transactionalEmails.accountId, accountId),
        gte(transactionalEmails.sentAt, cutoff),
        inArray(transactionalEmails.status, [...COUNTED_TX_STATUSES]),
      ),
    );

  // The NUMERATOR has to be counted per ADDRESS, not per message. A bounce or
  // complaint for any one recipient flips the whole message's status, so
  // grouping the recipient count by message status charged all 50 addresses of a
  // 50-recipient message for one dead mailbox — one such message read as a 100%
  // bounce rate on its own and paused the account. `email_events` already holds
  // exactly one row per (message, address, event type) — that is what its unique
  // index is for — so it is the honest source for "how many addresses actually
  // went wrong", and it makes transactional weigh the same as the per-recipient
  // campaign ledger.
  //
  // Bounce events are recorded for soft bounces too (the SES webhook records
  // first and gates only the status flip on Permanent/Undetermined), so the
  // bounce type is filtered here to match campaign semantics. `payload_json` is
  // the raw SNS notification held as text; a `::jsonb` cast would throw on any
  // row that is not parseable, so this matches the field textually instead —
  // `bounceType` appears exactly once in a bounce notification. The POSIX
  // character class avoids a backslash escape surviving the template literal.
  const txEventRows = await db
    .select({
      eventType: emailEvents.eventType,
      count: sql<number>`count(distinct (${emailEvents.transactionalEmailId} || ':' || coalesce(${emailEvents.email}, '')))`.as(
        "count",
      ),
    })
    .from(emailEvents)
    .innerJoin(transactionalEmails, eq(emailEvents.transactionalEmailId, transactionalEmails.id))
    .where(
      and(
        eq(emailEvents.accountId, accountId),
        gte(transactionalEmails.sentAt, cutoff),
        inArray(transactionalEmails.status, [...COUNTED_TX_STATUSES]),
        inArray(emailEvents.eventType, ["bounce", "complaint"]),
        sql`(${emailEvents.eventType} <> 'bounce' OR ${emailEvents.payloadJson} ~ '"bounceType"[[:space:]]*:[[:space:]]*"(Permanent|Undetermined)"')`,
      ),
    )
    .groupBy(emailEvents.eventType);

  const counts: Record<string, number> = {};
  for (const r of rows) {
    counts[r.status] = (counts[r.status] ?? 0) + Number(r.count);
  }
  const txCounts: Record<string, number> = {};
  for (const r of txEventRows) {
    txCounts[r.eventType] = Number(r.count);
  }

  const bounced = (counts.bounced ?? 0) + (txCounts.bounce ?? 0);
  const complained = (counts.complained ?? 0) + (txCounts.complaint ?? 0);
  const attempted =
    (counts.sent ?? 0) +
    (counts.delivered ?? 0) +
    (counts.bounced ?? 0) +
    (counts.complained ?? 0) +
    (counts.unsubscribed ?? 0) +
    Number(txAttemptedRow?.count ?? 0);

  const bounceRate = attempted > 0 ? bounced / attempted : 0;
  const complaintRate = attempted > 0 ? complained / attempted : 0;

  let status: AccountHealth["status"] = "normal";
  let reason: string | undefined;

  if (attempted >= MIN_ATTEMPTED_FOR_ENFORCEMENT) {
    // Both halves, always: the rate says the proportion is bad, the count says
    // there is enough of it to believe the rate. See MIN_BOUNCED_FOR_PAUSE.
    if (bounceRate >= BOUNCE_RATE_PAUSE && bounced >= MIN_BOUNCED_FOR_PAUSE) {
      status = "paused";
      reason = `Bounce rate ${(bounceRate * 100).toFixed(2)}% exceeded ${BOUNCE_RATE_PAUSE * 100}% (${bounced} bounced of ${attempted} sent)`;
    } else if (complaintRate >= COMPLAINT_RATE_PAUSE && complained >= MIN_COMPLAINED_FOR_PAUSE) {
      status = "paused";
      reason = `Complaint rate ${(complaintRate * 100).toFixed(3)}% exceeded ${COMPLAINT_RATE_PAUSE * 100}% (${complained} complaints of ${attempted} sent)`;
    } else if (bounceRate >= BOUNCE_RATE_WARNING || complaintRate >= COMPLAINT_RATE_WARNING) {
      // Warn early, pause late. The warning tier keeps the low volume floor on
      // purpose — it costs the tenant nothing and it is the signal an operator
      // wants long before an account is anywhere near a pause.
      status = "warning";
    }
  }

  return { attempted, bounced, complained, bounceRate, complaintRate, status, reason };
}

// Pauses the account if its health thresholds are exceeded. Returns the health.
export async function enforceAccountHealth(db: Db, accountId: string): Promise<AccountHealth> {
  const health = await computeAccountHealth(db, accountId);
  if (health.status === "paused") {
    // The `riskStatus = 'normal'` guard means RETURNING is non-empty only on the
    // actual normal→paused transition, not on the many later bounce/complaint
    // webhooks for an already-paused account — so we alert exactly once.
    const flipped = await db
      .update(accounts)
      .set({
        sendingEnabled: false,
        riskStatus: "paused",
        pausedReason: health.reason,
        updatedAt: nowIso(),
      })
      .where(and(eq(accounts.id, accountId), eq(accounts.riskStatus, "normal")))
      .returning({ id: accounts.id });

    if (flipped.length > 0) {
      // A reputation auto-pause is one of the highest-severity operational
      // events (it can precede an SES account-level suspension that affects every
      // tenant), so ship it to the error sink to page on-call — not just a log
      // line nobody reads. Best-effort; never block the webhook/send path.
      void logger.reportError(
        "account auto-paused for reputation (bounce/complaint rate)",
        new Error(health.reason ?? "reputation threshold exceeded"),
        {
          accountId,
          attempted: health.attempted,
          bounced: health.bounced,
          complained: health.complained,
          bounceRate: Number(health.bounceRate.toFixed(4)),
          complaintRate: Number(health.complaintRate.toFixed(5)),
          windowDays: HEALTH_WINDOW_DAYS,
        },
      );
      // Tell the tenant too — they're the only one who can fix their list, and
      // without this their in-flight campaign just stops with no explanation.
      // Best-effort and guarded by the exactly-once transition above. Imported
      // lazily to keep this module free of a static notifications dependency
      // (notifications imports the email factory).
      try {
        const { notifyAccount } = await import("./notifications");
        const account = await db.query.accounts.findFirst({
          where: eq(accounts.id, accountId),
        });
        if (account) {
          await notifyAccount(db, account, {
            kind: "account_paused",
            title: "Sending is paused for your workspace",
            body: `${health.reason ?? "Bounce or complaint rates exceeded the safe threshold."} Clean up your audience (remove stale or purchased addresses), then contact support to re-enable sending.`,
            ctaHref: "/audiences",
            ctaLabel: "Review your audience",
          });
        }
      } catch (err) {
        console.error("[health] account-paused notification failed", err);
      }
    }
  }
  return health;
}
