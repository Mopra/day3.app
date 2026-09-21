// How fast a NEW account is allowed to spend the send allowance it bought.
//
// The monthly plan limit answers "how much did this customer pay for". It does
// not answer "should a workspace created four minutes ago be allowed to put
// 100,000 emails on the shared SES identity tonight", and those are different
// questions. Both phishing accounts we have seen bought a large plan within
// minutes of signing up and went from zero to ~3,000 emails an hour on day one;
// the plan limit was never the thing standing in their way, and reputation
// damage is done long before a 50,000-email ceiling is reached.
//
// So sending also ramps with account age. This is the standard practice every
// established ESP applies to new senders, and it is good for honest customers
// too: a brand new domain that mails 50,000 strangers on its first night gets
// filtered on reputation grounds no matter how clean the list is. Warming up is
// how you land in inboxes.
//
// WHAT THIS IS NOT. It is not a second meter. It never grants anything the plan
// would not have granted — it only lowers the ceiling for a while, and it
// enforces at the same choke point every real send already passes through
// (`reserveQuota`), so no send path can forget to opt in. See AGENTS.md on the
// one ledger.
import type { Account } from "../db/schema";

export type RampTier = {
  /** Account age in whole days at which this tier starts applying. */
  fromDay: number;
  /** Emails per UTC day allowed while in this tier. */
  perDay: number;
};

// Roughly a doubling per step, reaching "no practical ceiling" after two weeks.
// The day-0 number is the important one: it is small enough that a phishing run
// is a few hundred emails and an operator alert rather than a reputation
// incident, and large enough that a real customer's first day of integration
// testing, welcome emails and a first small campaign never notices it.
export const RAMP_TIERS: RampTier[] = [
  { fromDay: 0, perDay: 500 },
  { fromDay: 1, perDay: 2_000 },
  { fromDay: 3, perDay: 10_000 },
  { fromDay: 7, perDay: 50_000 },
  { fromDay: 14, perDay: Number.MAX_SAFE_INTEGER },
];

/** Whole days since the account was created (UTC), floored at 0. */
export function accountAgeDays(account: Pick<Account, "createdAt">, now = new Date()): number {
  const created = new Date(account.createdAt).getTime();
  if (!Number.isFinite(created)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor((now.getTime() - created) / 86_400_000));
}

/** The UTC calendar day a daily counter is keyed by. */
export function utcDayKey(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * Emails this account may still send today, or `null` for "no ramp applies"
 * (aged out, or lifted by an operator).
 *
 * Returns the REMAINING allowance, not the tier size, so the caller can hand it
 * straight to `reserveQuota` as a ceiling.
 */
export function rampRemaining(
  account: Pick<Account, "createdAt" | "dailySentCount" | "dailySentDate" | "rampLiftedAt">,
  now = new Date(),
): number | null {
  if (account.rampLiftedAt) return null;

  const age = accountAgeDays(account, now);
  const tier = [...RAMP_TIERS].reverse().find((t) => age >= t.fromDay) ?? RAMP_TIERS[0];
  if (tier.perDay === Number.MAX_SAFE_INTEGER) return null;

  // A counter from an earlier day is spent history, not today's usage. The
  // reset is lazy (here and in the SQL below) rather than a cron job, because a
  // scheduled reset that fails to run would silently hold every account at its
  // previous day's total.
  const spentToday = account.dailySentDate === utcDayKey(now) ? account.dailySentCount : 0;
  return Math.max(0, tier.perDay - spentToday);
}

/** The tier ceiling in force for this account today (for UI and messages). */
export function rampDailyLimit(
  account: Pick<Account, "createdAt" | "rampLiftedAt">,
  now = new Date(),
): number | null {
  if (account.rampLiftedAt) return null;
  const age = accountAgeDays(account, now);
  const tier = [...RAMP_TIERS].reverse().find((t) => age >= t.fromDay) ?? RAMP_TIERS[0];
  return tier.perDay === Number.MAX_SAFE_INTEGER ? null : tier.perDay;
}

/** What a caller is told when the ramp, rather than the plan, is what stopped them. */
export function rampExhaustedMessage(limit: number): string {
  return (
    `New workspaces ramp up their sending over the first two weeks, and this one has reached ` +
    `today's ${limit.toLocaleString("en-US")}-email ceiling. Sending resumes at 00:00 UTC, and the ` +
    `ceiling rises on its own as the account ages. If you need it lifted sooner, contact support — ` +
    `warming up a new sending domain gradually is also what keeps your mail out of spam folders.`
  );
}
