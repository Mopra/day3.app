import { eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { subscribers } from "../db/schema";
import { maxSubscribersForPlan } from "../lib/plans-catalog";

// Spam/abuse protection for the set-up-only free tier: an account that can't send
// shouldn't be able to hoard an unbounded subscriber list. Paid tiers are
// unlimited (cap = null). All subscriber-insert paths (manual add, CSV import,
// public form) gate through these helpers.

// Total subscriber rows for an account (all statuses — the cap is about stored
// rows, not just sendable ones).
export async function countAccountSubscribers(db: Db, accountId: string): Promise<number> {
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(subscribers)
    .where(eq(subscribers.accountId, accountId));
  return Number(count);
}

// How many more subscribers an account on `plan` may add. Infinity for unlimited
// (paid) tiers; never negative.
export async function subscriberHeadroom(
  db: Db,
  accountId: string,
  plan: string,
): Promise<number> {
  const cap = maxSubscribersForPlan(plan);
  if (cap === null) return Infinity;
  const current = await countAccountSubscribers(db, accountId);
  return Math.max(0, cap - current);
}

// The user-facing message when a subscriber cap blocks an add/import.
export function subscriberLimitMessage(plan: string): string {
  const cap = maxSubscribersForPlan(plan);
  const capText = cap === null ? "" : cap.toLocaleString();
  return `The Free plan is limited to ${capText} subscribers. Upgrade to a paid plan for unlimited subscribers.`;
}
