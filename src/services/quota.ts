import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts } from "../db/schema";
import { nowIso } from "../lib/ids";

// Monthly send-quota accounting, shared by the send-batch handler (reserve up
// front, release what didn't send) and the cron sweep (release the reservation
// of rows it fails as stuck). The counter is the abuse/billing boundary that
// protects the shared SES reputation, so every mutation here is a single
// conditional statement — never read-then-write.

// Atomically reserves up to `amount` units of monthly send quota and returns
// how many were actually granted (0 when the account is at its limit). The CTE
// captures the pre-update count under a row lock so `granted` is the true
// new-minus-old delta — RETURNING on its own only exposes post-update values.
// Doing the read-and-conditional-increment in one statement is what bounds the
// total across concurrent workers by the limit instead of by a stale read.
export async function reserveQuota(db: Db, accountId: string, amount: number): Promise<number> {
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
export async function releaseReservation(db: Db, accountId: string, amount: number): Promise<void> {
  if (amount <= 0) return;
  await db
    .update(accounts)
    .set({
      // GREATEST guards against the counter dipping below zero if reservations
      // and releases ever interleave unexpectedly (e.g. across a monthly reset).
      monthlyEmailSentCount: sql`GREATEST(${accounts.monthlyEmailSentCount} - ${amount}, 0)`,
      updatedAt: nowIso(),
    })
    .where(eq(accounts.id, accountId));
}
