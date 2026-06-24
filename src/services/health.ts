import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, campaignRecipients } from "../db/schema";
import { nowIso } from "../lib/ids";
import { logger } from "../lib/logger";

export const BOUNCE_RATE_WARNING = 0.03;
export const BOUNCE_RATE_PAUSE = 0.04;
export const COMPLAINT_RATE_WARNING = 0.0005;
export const COMPLAINT_RATE_PAUSE = 0.0008;

// Below this many attempted sends, rates are too noisy to act on.
const MIN_ATTEMPTED_FOR_ENFORCEMENT = 50;

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

  const counts = Object.fromEntries(rows.map((r) => [r.status, Number(r.count)]));
  const bounced = counts.bounced ?? 0;
  const complained = counts.complained ?? 0;
  const attempted =
    (counts.sent ?? 0) + (counts.delivered ?? 0) + bounced + complained + (counts.unsubscribed ?? 0);

  const bounceRate = attempted > 0 ? bounced / attempted : 0;
  const complaintRate = attempted > 0 ? complained / attempted : 0;

  let status: AccountHealth["status"] = "normal";
  let reason: string | undefined;

  if (attempted >= MIN_ATTEMPTED_FOR_ENFORCEMENT) {
    if (bounceRate >= BOUNCE_RATE_PAUSE) {
      status = "paused";
      reason = `Bounce rate ${(bounceRate * 100).toFixed(2)}% exceeded ${BOUNCE_RATE_PAUSE * 100}%`;
    } else if (complaintRate >= COMPLAINT_RATE_PAUSE) {
      status = "paused";
      reason = `Complaint rate ${(complaintRate * 100).toFixed(3)}% exceeded ${COMPLAINT_RATE_PAUSE * 100}%`;
    } else if (bounceRate >= BOUNCE_RATE_WARNING || complaintRate >= COMPLAINT_RATE_WARNING) {
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
    }
  }
  return health;
}
