import { eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts } from "../db/schema";
import { nowIso } from "../lib/ids";
import { RAMP_TIERS, rampDailyLimit, rampExhaustedMessage, utcDayKey } from "./send-ramp";

// Monthly send-quota accounting, shared by the send-batch handler (reserve up
// front, release what didn't send) and the cron sweep (release the reservation
// of rows it fails as stuck). The counter is the abuse/billing boundary that
// protects the shared SES reputation, so every mutation here is a single
// conditional statement — never read-then-write.

// The new-account ramp, rendered as SQL.
//
// It is enforced HERE, inside the one statement every real send already passes
// through, rather than at each send path. A ceiling that each caller has to
// remember to apply is a ceiling the next send path forgets — and "the next
// send path forgot" is exactly how the transactional API came to have no
// content review. See services/send-ramp.ts for the reasoning behind the tiers.
//
// Generated from RAMP_TIERS so the numbers live in one place: TypeScript owns
// the policy, this only translates it. NULL means "no ramp applies" (aged out,
// or lifted by an operator), which COALESCEs to an effectively infinite ceiling
// below so the plan limit is the only thing left.
function rampLimitSql(now: Date): SQL {
  const ascending = [...RAMP_TIERS].sort((a, b) => a.fromDay - b.fromDay);
  const branches: SQL[] = [];
  for (let i = 0; i < ascending.length; i++) {
    const next = ascending[i + 1];
    if (!next) break; // the last tier is the uncapped one
    // In tier i while the account is younger than where tier i+1 starts.
    const cutoff = new Date(now.getTime() - next.fromDay * 86_400_000).toISOString();
    branches.push(sql`when ${accounts.createdAt} > ${cutoff} then ${ascending[i].perDay}::bigint`);
  }
  return sql`case when ${accounts.rampLiftedAt} is not null then null ${sql.join(branches, sql` `)} else null end`;
}

/**
 * Atomically reserves up to `amount` units of send quota and returns how many
 * were actually granted (0 when the account is at a limit).
 *
 * Two ceilings apply in the same statement: the monthly plan allowance (what
 * the customer bought) and the new-account daily ramp (how fast a young
 * workspace may spend it). The CTE captures the pre-update counts under a row
 * lock so `granted` is the true delta — RETURNING on its own only exposes
 * post-update values — and doing read-and-conditional-increment in ONE
 * statement is what bounds the totals across concurrent workers by the limits
 * rather than by a stale read.
 *
 * `limitOverride` substitutes a caller-supplied monthly ceiling while still
 * using the same counter — the transactional sandbox (free orgs, plan limit 0)
 * reserves against a small fixed allowance this way, so sandbox sends share the
 * one atomic ledger with everything else.
 *
 * The daily counter resets lazily: a `daily_sent_date` that is not today reads
 * as zero spent and is overwritten on the next reservation. Lazy rather than a
 * scheduled reset because a cron that fails to run would silently hold every
 * account at yesterday's total.
 */
export async function reserveQuota(
  db: Db,
  accountId: string,
  amount: number,
  limitOverride?: number,
  now: Date = new Date(),
): Promise<number> {
  const today = utcDayKey(now);
  const rows = await db.execute<{ granted: number }>(sql`
    WITH prev AS (
      SELECT monthly_email_sent_count AS old_count,
             ${limitOverride === undefined ? sql`monthly_email_limit` : limitOverride}::bigint AS lim,
             CASE WHEN daily_sent_date = ${today} THEN daily_sent_count ELSE 0 END AS day_count,
             COALESCE(${rampLimitSql(now)}, 9223372036854775807::bigint) AS day_lim
      FROM accounts WHERE id = ${accountId} FOR UPDATE
    ), calc AS (
      SELECT old_count, day_count,
             LEAST(
               ${amount}::bigint,
               GREATEST(lim - old_count, 0),
               GREATEST(day_lim - day_count, 0)
             ) AS granted
      FROM prev
    )
    UPDATE accounts
    SET monthly_email_sent_count = calc.old_count + calc.granted,
        daily_sent_count = calc.day_count + calc.granted,
        daily_sent_date = ${today},
        updated_at = ${nowIso()}
    FROM calc
    WHERE accounts.id = ${accountId}
    RETURNING calc.granted AS granted
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
//
// Both counters are released together. They were incremented together, and a
// release that only credited the monthly one would let a day's worth of
// abandoned reservations eat a young account's ramp for real sends it never
// made.
export async function releaseReservation(
  db: Db,
  accountId: string,
  amount: number,
  now: Date = new Date(),
): Promise<void> {
  if (amount <= 0) return;
  const today = utcDayKey(now);
  await db
    .update(accounts)
    .set({
      // GREATEST guards against the counter dipping below zero if reservations
      // and releases ever interleave unexpectedly (e.g. across a monthly reset).
      monthlyEmailSentCount: sql`GREATEST(${accounts.monthlyEmailSentCount} - ${amount}, 0)`,
      // Only today's counter can be credited: a release landing after midnight
      // belongs to a day that is already closed, and decrementing the fresh
      // day's count for it would hand back allowance that was never spent today.
      dailySentCount: sql`CASE WHEN ${accounts.dailySentDate} = ${today} THEN GREATEST(${accounts.dailySentCount} - ${amount}, 0) ELSE ${accounts.dailySentCount} END`,
      updatedAt: nowIso(),
    })
    .where(eq(accounts.id, accountId));
}

/**
 * Why a reservation came up short, for the message shown to the caller.
 *
 * Only ever called on the refusal path (a send that was actually denied), so
 * the extra read costs nothing in the normal case. It exists because "Monthly
 * email limit reached. Upgrade your plan." is actively misleading to a
 * day-old account that has plenty of plan left and simply hit its ramp — that
 * customer would upgrade and still be stuck.
 */
export async function quotaBlockReason(
  db: Db,
  accountId: string,
  now: Date = new Date(),
): Promise<{ limitedBy: "ramp" | "plan"; message: string | null }> {
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  if (!account) return { limitedBy: "plan", message: null };

  const dailyLimit = rampDailyLimit(account, now);
  const spentToday = account.dailySentDate === utcDayKey(now) ? account.dailySentCount : 0;
  if (dailyLimit !== null && spentToday >= dailyLimit) {
    return { limitedBy: "ramp", message: rampExhaustedMessage(dailyLimit) };
  }
  return { limitedBy: "plan", message: null };
}
