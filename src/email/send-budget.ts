import { logger } from "../lib/logger";
import type {
  EmailProvider,
  ProviderSendQuota,
  SendEmailResult,
  SendKind,
} from "./provider";
import { E_DAILY_LIMIT_EXCEEDED } from "./ses";

// The account-wide 24-hour send budget: how much of the provider's daily
// ceiling is left, and when the next of it comes back.
//
// SES enforces a maximum send *rate* (emails/second, paced in send-rate.ts) and,
// separately, a maximum number of emails per rolling 24 hours. The rate ceiling
// is a queueing problem; the daily ceiling is a cliff. Nothing used to know
// about it: we discovered it by having SES reject a send mid-campaign, which
// means the whole platform hits the wall at the same instant, including the
// double opt-in confirmations, form confirmations and account notifications that
// have nothing to do with the campaign that spent the quota.
//
// Two ideas make that survivable, and they are the whole module:
//
//   1. **Bulk yields before transactional does.** A slice of the daily ceiling
//      is held back (TRANSACTIONAL_RESERVE_FRACTION) and campaign/automation
//      mail is refused once it would eat into that slice. Transactional mail is
//      NEVER refused here. A signup confirmation that doesn't arrive breaks the
//      product for someone who is standing there waiting for it, and if SES is
//      truly out it will say so itself. This is triage, not a second meter: no
//      tenant is capped, and a customer who buys 100k emails may still spend all
//      100k in one day.
//   2. **Refusal is a hold, never a loss.** A refused bulk send returns the same
//      `rate_limited` + E_DAILY_LIMIT_EXCEEDED contract SES itself returns, so
//      the existing handlers do exactly what they already do: return the batch's
//      remaining recipients to `pending`, pause the campaign with
//      `paused_code='daily_limit'` (automations: `hold_reason`), notify the
//      account, and let the cron sweep resume it. What this adds is that we now
//      know *when* to resume instead of retrying blind every two hours.
//
// Accounting. Every send the worker makes increments an hourly Redis bucket, so
// all lanes and all replicas draw down one shared number (same reasoning as the
// pacer's Redis-held rate). The bucket for the current hour is read and bumped
// in one Lua round trip, which is what makes the check race-free across
// replicas; older buckets only change as they age out, so their sum is cached
// with the periodic quota refresh. SES's own `SentLast24Hours` is read alongside
// and any excess over our ledger is carried as an offset: the web tier sends
// transactional mail through an unwrapped provider, so our buckets under-count
// by design and SES's number is the authority on the level.
//
// Everything here fails OPEN. An unreadable quota, an unreachable Redis or an
// unknown ceiling all mean "send it": this module exists to stop mail being
// *lost*, and a budget that stops mail on its own would be worse than the
// problem it solves.

/** Redis key prefix for the hourly send counters. The value is a send count. */
export const SEND_BUDGET_PREFIX = "day3:send-budget:h:";
/** Redis key prefix for the alert dedup locks (one per threshold per window). */
export const SEND_BUDGET_ALERT_PREFIX = "day3:send-budget:alert:";

const HOUR_MS = 3_600_000;

/** Hours of history the rolling window covers. SES's quota is per 24 hours. */
export const WINDOW_HOURS = 24;

// A bucket has to outlive the window it belongs to: the newest send in bucket H
// leaves the rolling window at H+25h, and the recovery estimate reads it until
// then. An hour of slack past that costs a handful of integer keys.
const BUCKET_TTL_MS = 26 * HOUR_MS;

// How long a quota reading is trusted. AWS moves the ceiling on its own (and an
// operator can raise it mid-incident), and `SentLast24Hours` drifts against our
// own ledger, so this refreshes the *slow* parts only. The current hour's
// bucket is always read live.
const REFRESH_MS = 60_000;
// Near the line, the offset between our ledger and SES's count matters more, so
// look more often. Cheap: GetAccount is one API call per replica per interval.
const BUSY_REFRESH_MS = 10_000;
const BUSY_FRACTION = 0.8;

/**
 * Share of the daily ceiling held back for transactional mail. At a 50k/day
 * ceiling this is 1,000 emails a campaign cannot touch, enough for a day of
 * confirmations, account notifications and API sends on top of whatever the
 * campaign already spent. Sized as a fraction so it grows with the account, with
 * a floor for small ceilings where 2% would round down to nothing.
 */
export const TRANSACTIONAL_RESERVE_FRACTION = 0.02;
export const MIN_TRANSACTIONAL_RESERVE = 500;

/**
 * Usage levels worth telling a human about, as a fraction of the daily ceiling.
 *
 * 70% pages rather than merely logging because the remedy is slow: an SES quota
 * increase is a support request that takes the better part of a day, so learning
 * at 70% is what makes it actionable at all, and the 6-hour dedup keeps that to
 * at most four a day while volume grows into the ceiling. 90% and 98% mean mail
 * is about to stop, so they repeat hourly until the window frees up.
 */
export const ALERT_LEVELS: { fraction: number; dedupSeconds: number }[] = [
  { fraction: 0.7, dedupSeconds: 6 * 3600 },
  { fraction: 0.9, dedupSeconds: 3600 },
  { fraction: 0.98, dedupSeconds: 3600 },
];

/** The ioredis slice this module uses, narrow so tests can inject a fake. */
export interface SendBudgetStore {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  mget(...keys: string[]): Promise<(string | null)[]>;
}

export type BudgetStatus = {
  /** False when no ceiling could be read; every caller then sends unmetered. */
  known: boolean;
  max24h: number | null;
  /** Best estimate of sends in the trailing window, ours plus the SES offset. */
  sent24h: number;
  /** Emails left before the provider's own ceiling. */
  headroom: number;
  /** Emails left before bulk must yield (headroom minus the reserve). */
  bulkHeadroom: number;
  usedFraction: number;
  /** When enough of the window ages out for bulk to flow again; null if now. */
  bulkRecoversAt: string | null;
  refreshedAt: string;
};

export type BudgetClaim =
  | { ok: true; release: () => Promise<void> }
  | { ok: false; error: string };

export type SendBudget = {
  /**
   * Take one email's worth of budget for a send that is about to happen.
   * `ok: false` means the caller must NOT send. The reason string is already in
   * the E_DAILY_LIMIT_EXCEEDED contract the handlers branch on.
   */
  claim(kind: SendKind): Promise<BudgetClaim>;
  /** Refresh-if-stale, then report. Used by the cron sweep to decide a resume. */
  status(): Promise<BudgetStatus>;
  /** Resolve the ceiling once at boot so the first send is already metered. */
  warmUp(): Promise<BudgetStatus>;
};

// --- pure helpers (exported for tests) --------------------------------------

/** Redis key for the hour containing `ms`. */
export function bucketKey(ms: number): string {
  return `${SEND_BUDGET_PREFIX}${Math.floor(ms / HOUR_MS)}`;
}

/** The window's bucket keys, oldest first, including the current partial hour. */
export function windowKeys(now: number, hours = WINDOW_HOURS): string[] {
  const current = Math.floor(now / HOUR_MS);
  const keys: string[] = [];
  for (let i = hours - 1; i >= 0; i--) keys.push(`${SEND_BUDGET_PREFIX}${current - i}`);
  return keys;
}

export type Bucket = { start: number; count: number };

/**
 * When `need` emails of headroom come back, purely from old sends ageing out of
 * the rolling window.
 *
 * A send at time t stops counting at t+24h, and a bucket [H, H+1h) holds sends
 * up to H+1h, so the bucket is fully out of the window at H+25h. Using the
 * bucket's *end* rather than its start is the honest direction to round: a
 * promise of "back by 14:00" that turns into 14:59 reads as broken, the reverse
 * does not. Returns null when ageing alone can never free that much, and the
 * caller then says "as soon as capacity frees up" instead of inventing a time.
 */
export function estimateRecovery(buckets: Bucket[], now: number, need: number): number | null {
  if (need <= 0) return null;
  let freed = 0;
  for (const bucket of buckets) {
    if (bucket.count <= 0) continue;
    const agesOutAt = bucket.start + HOUR_MS + WINDOW_HOURS * HOUR_MS;
    if (agesOutAt <= now) continue; // already gone from the window
    freed += bucket.count;
    if (freed >= need) return agesOutAt;
  }
  return null;
}

/** The share of the ceiling bulk mail may use. */
export function bulkCeilingFor(max24h: number): number {
  const reserve = Math.max(
    MIN_TRANSACTIONAL_RESERVE,
    Math.ceil(max24h * TRANSACTIONAL_RESERVE_FRACTION),
  );
  return Math.max(0, max24h - reserve);
}

/** The alert levels `usedFraction` has crossed, highest first. */
export function alertsFor(usedFraction: number): typeof ALERT_LEVELS {
  return ALERT_LEVELS.filter((level) => usedFraction >= level.fraction).reverse();
}

/**
 * The user-facing pause reason for a daily-ceiling hold. Deliberately says that
 * nothing is lost, and that this is our ceiling rather than their plan limit:
 * the failure is ours, and a user who reads "limit reached" assumes they have to
 * buy something.
 */
export function dailyLimitPauseReason(retryAt: Date | null, now = new Date()): string {
  const base =
    "Sending is paused because Day3 reached its email provider's daily sending ceiling. " +
    "Your remaining recipients are still queued (nothing is lost), and sending resumes automatically";
  if (!retryAt) return `${base} as soon as capacity frees up, usually within a few hours.`;
  const hours = Math.max(1, Math.round((retryAt.getTime() - now.getTime()) / HOUR_MS));
  return `${base}, expected within about ${hours} ${hours === 1 ? "hour" : "hours"}.`;
}

/** Marker appended to a refusal so the handler can quote a resume time. */
const RETRY_AT = "retry_at=";

export function budgetRefusal(retryAt: number | null): string {
  const suffix = retryAt ? `${RETRY_AT}${new Date(retryAt).toISOString()}` : "retry pending";
  return `${E_DAILY_LIMIT_EXCEEDED}: daily sending budget exhausted; ${suffix}`;
}

/** Reads back what budgetRefusal wrote. Absent or unparseable → null. */
export function parseRetryAt(error: string | undefined): Date | null {
  const match = /retry_at=(\S+)/.exec(error ?? "");
  if (!match) return null;
  const ms = Date.parse(match[1]);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

// --- Redis scripts ----------------------------------------------------------

// Take a slot in the current hour's bucket, or refuse. One round trip, so two
// replicas at the line can only ever divide what is left. Same
// read-and-conditional-increment-in-one-statement rule as services/quota.ts.
//
// KEYS[1] bucket · ARGV[1] max for this bucket (-1 = unmetered) · ARGV[2] ttl ms
// → the new count, or -1 when refused
const CONSUME_LUA = `
local limit = tonumber(ARGV[1])
if limit >= 0 then
  local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
  if cur >= limit then return -1 end
end
local n = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[2]))
return n
`;

// Give a claimed slot back when the send provably did not happen.
// KEYS[1] bucket → 0
const RELEASE_LUA = `
local n = tonumber(redis.call('GET', KEYS[1]) or '0')
if n > 0 then redis.call('DECR', KEYS[1]) end
return 0
`;

// Claim the right to raise one alert. KEYS[1] lock · ARGV[1] ttl seconds → 1 if ours
const ALERT_LUA = `
if redis.call('SET', KEYS[1], '1', 'NX', 'EX', tonumber(ARGV[1])) then return 1 end
return 0
`;

// --- the budget -------------------------------------------------------------

export type SendBudgetOptions = {
  store: SendBudgetStore;
  /**
   * Reads the provider's daily ceiling and its own usage. Absent means the
   * provider has no daily ceiling worth tracking (the mock) and the budget
   * no-ops; throwing means we could not ask, and we fail open until it answers.
   */
  quota?: () => Promise<ProviderSendQuota | null>;
  /** Fixed ceiling override; skips discovery (SES_MAX_24H_SEND). */
  max24h?: number;
  now?: () => number;
};

function storeTimeoutMs(): number {
  return Number(process.env.SEND_BUDGET_STORE_TIMEOUT_MS) || 2000;
}

// Same hard bound, and for the same reason, as the pacer's: the shared BullMQ
// producer connection runs with `maxRetriesPerRequest: null`, so a command
// issued while Redis is down never rejects: it hangs. Without this the
// fail-open path below is unreachable and an outage would stop all mail.
function withTimeout<T>(op: Promise<T>): Promise<T> {
  const ms = storeTimeoutMs();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`send budget store did not respond within ${ms}ms`)),
      ms,
    );
    op.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export function createSendBudget(opts: SendBudgetOptions): SendBudget {
  const now = opts.now ?? (() => Date.now());
  const override = Number(opts.max24h ?? process.env.SES_MAX_24H_SEND ?? 0);

  // The slow-moving half of the picture, refreshed on an interval:
  //   max24h:  the provider's ceiling
  //   base:    sends in the window BEFORE the current hour, plus the offset for
  //            traffic our buckets never saw (web-tier transactional mail)
  //   buckets: the window's shape, which is what dates the recovery estimate
  let max24h: number | null = null;
  let base = 0;
  let buckets: Bucket[] = [];
  let refreshedAt = 0;
  let inFlight: Promise<void> | null = null;
  let loggedStoreFailure = false;

  function currentCount(): number {
    return buckets[buckets.length - 1]?.count ?? 0;
  }

  async function readBuckets(at: number): Promise<Bucket[]> {
    const keys = windowKeys(at);
    const values = await withTimeout(opts.store.mget(...keys));
    const firstHour = Math.floor(at / HOUR_MS) - (WINDOW_HOURS - 1);
    return keys.map((_, index) => ({
      start: (firstHour + index) * HOUR_MS,
      count: Math.max(0, Number(values?.[index] ?? 0) || 0),
    }));
  }

  function recoveryFor(sent: number, at: number): string | null {
    if (max24h === null) return null;
    const overshoot = sent - bulkCeilingFor(max24h);
    if (overshoot < 0) return null;
    const ms = estimateRecovery(buckets, at, overshoot + 1);
    return ms ? new Date(ms).toISOString() : null;
  }

  async function raiseAlerts(at: number): Promise<void> {
    if (max24h === null) return;
    const sent = base + currentCount();
    const fraction = sent / max24h;
    const crossed = alertsFor(fraction)[0];
    if (!crossed) return;
    const key = `${SEND_BUDGET_ALERT_PREFIX}${crossed.fraction}`;
    let mine = false;
    try {
      mine =
        Number(await withTimeout(opts.store.eval(ALERT_LUA, 1, key, crossed.dedupSeconds))) === 1;
    } catch {
      return; // the level is still visible on the admin SES card
    }
    if (!mine) return;
    const context = {
      usedPercent: Math.round(fraction * 100),
      sent24h: sent,
      max24h,
      headroom: Math.max(0, max24h - sent),
      bulkRecoversAt: recoveryFor(sent, at),
    };
    // reportError is the paging channel. Every level pages: by the time mail
    // actually stops, the only remedies (an AWS quota increase, or waiting out
    // the window) are hours long, so an alert that arrives at the cliff arrives
    // too late to do anything with.
    void logger.reportError(
      `daily send budget at ${context.usedPercent}% of the provider ceiling`,
      new Error(`send budget ${context.usedPercent}% used`),
      context,
    );
  }

  async function refresh(): Promise<void> {
    const at = now();
    let quota: ProviderSendQuota | null = null;
    if (override > 0) {
      quota = { max24h: override, sent24h: 0, maxSendRate: null };
    } else if (opts.quota) {
      try {
        quota = await opts.quota();
      } catch (err) {
        // Keep whatever ceiling we already had: a transient GetAccount failure
        // must not silently un-meter (or, worse, zero) the budget.
        logger.warn("daily send budget: quota lookup failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        refreshedAt = at;
        return;
      }
    }

    let window: Bucket[];
    try {
      window = await readBuckets(at);
    } catch (err) {
      logger.warn("daily send budget: ledger read failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      refreshedAt = at;
      return;
    }

    buckets = window;
    max24h = quota && quota.max24h > 0 ? quota.max24h : null;

    const ours = window.reduce((sum, bucket) => sum + bucket.count, 0);
    // Mail we never counted (the web tier sends transactional mail through an
    // unwrapped provider) plus whatever lag sits between SES's counter and ours.
    // Never negative: our own ledger leads SES's by a moment on a busy minute,
    // and a negative offset would hand out headroom that does not exist.
    const offset = quota ? Math.max(0, quota.sent24h - ours) : 0;
    base = ours - currentCount() + offset;
    refreshedAt = at;

    if (max24h !== null) await raiseAlerts(at);
  }

  function refreshIfStale(): void {
    if (inFlight) return;
    const busy = max24h !== null && (base + currentCount()) / max24h >= BUSY_FRACTION;
    if (now() - refreshedAt < (busy ? BUSY_REFRESH_MS : REFRESH_MS)) return;
    inFlight = refresh().finally(() => {
      inFlight = null;
    });
    void inFlight.catch(() => {});
  }

  function snapshot(at: number): BudgetStatus {
    const sent = base + currentCount();
    return {
      known: max24h !== null,
      max24h,
      sent24h: sent,
      headroom: max24h === null ? Number.POSITIVE_INFINITY : Math.max(0, max24h - sent),
      bulkHeadroom:
        max24h === null ? Number.POSITIVE_INFINITY : Math.max(0, bulkCeilingFor(max24h) - sent),
      usedFraction: max24h === null ? 0 : sent / max24h,
      bulkRecoversAt: recoveryFor(sent, at),
      refreshedAt: new Date(refreshedAt || at).toISOString(),
    };
  }

  return {
    async warmUp(): Promise<BudgetStatus> {
      await refresh();
      const status = snapshot(now());
      logger.info("daily send budget configured", {
        max24h: status.max24h ?? "unmetered",
        sent24h: status.sent24h,
        bulkHeadroom: Number.isFinite(status.bulkHeadroom) ? status.bulkHeadroom : "unmetered",
        source: override > 0 ? "SES_MAX_24H_SEND" : opts.quota ? "provider" : "none",
      });
      return status;
    },

    async status(): Promise<BudgetStatus> {
      const at = now();
      const busy = max24h !== null && (base + currentCount()) / max24h >= BUSY_FRACTION;
      if (at - refreshedAt >= (busy ? BUSY_REFRESH_MS : REFRESH_MS)) {
        if (inFlight) await inFlight.catch(() => {});
        else await refresh().catch(() => {});
      }
      return snapshot(now());
    },

    async claim(kind: SendKind): Promise<BudgetClaim> {
      refreshIfStale();
      const at = now();
      const key = bucketKey(at);
      // Transactional mail is never refused here (see the header): it passes -1
      // so it is still *counted*, which is what keeps the bulk ceiling honest.
      const limit =
        kind === "bulk" && max24h !== null ? Math.max(0, bulkCeilingFor(max24h) - base) : -1;

      let count: number;
      try {
        count = Number(
          await withTimeout(opts.store.eval(CONSUME_LUA, 1, key, limit, BUCKET_TTL_MS)),
        );
      } catch (err) {
        // Fail OPEN, logged once: this runs per email, and unmetered sending is
        // the pre-existing behaviour, and SES's own rejection still backstops it.
        if (!loggedStoreFailure) {
          loggedStoreFailure = true;
          logger.warn("daily send budget unavailable; sending unmetered", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return { ok: true, release: async () => {} };
      }
      loggedStoreFailure = false;

      if (count < 0) {
        const retryAt = estimateRecovery(buckets, at, 1);
        logger.warn("daily send budget exhausted for bulk mail; holding", {
          sent24h: base + limit,
          max24h,
          retryAt: retryAt ? new Date(retryAt).toISOString() : null,
        });
        return { ok: false, error: budgetRefusal(retryAt) };
      }

      // Keep the local view moving between refreshes, so a burst inside one
      // interval is metered against what it has already spent rather than
      // against a 60-second-old number.
      const bucket = buckets[buckets.length - 1];
      const live = bucket && bucket.start === Math.floor(at / HOUR_MS) * HOUR_MS ? bucket : null;
      if (live) live.count = count;

      return {
        ok: true,
        release: async () => {
          try {
            await withTimeout(opts.store.eval(RELEASE_LUA, 1, key));
            if (live && live.count > 0) live.count -= 1;
          } catch {
            // Best-effort: an unreleased slot costs a little headroom until the
            // next refresh reconciles against SES's own count.
          }
        },
      };
    },
  };
}

// --- the provider decorator -------------------------------------------------

/**
 * Wraps a provider so every send draws on the daily budget, and bulk mail is
 * held back before the provider has to reject it.
 *
 * Applied OUTSIDE the pacer (`withSendBudget(withSendPacing(provider, pacer))`)
 * on purpose: a send that is going to be refused should not first wait for a
 * rate slot, and must not consume one: the slot belongs to mail that is
 * actually going out.
 *
 * A refusal is safe to retry by construction. It returns `rate_limited`, which
 * in the provider contract means the request was rejected *before* sending, and
 * here that is literally true (we never called the provider), so the handlers'
 * existing rule of returning the batch's remainder to `pending` cannot duplicate
 * an email.
 */
export function withSendBudget(provider: EmailProvider, budget: SendBudget): EmailProvider {
  const metered: EmailProvider = {
    async send(input) {
      const claim = await budget.claim(input.kind ?? "transactional");
      if (!claim.ok) {
        const refusal: SendEmailResult = {
          // Only a provider that reports a ceiling is ever metered, which today
          // means SES; the mock's budget has no ceiling and never refuses.
          provider: "ses",
          status: "rate_limited",
          error: claim.error,
        };
        return refusal;
      }
      const result = await provider.send(input);
      // Give the slot back when the email provably did not leave. "failed" is
      // deliberately NOT released: it covers ambiguous transport errors where
      // SES may already have accepted the message, and over-counting our own
      // budget is the safe direction to be wrong in.
      if (
        result.status === "rate_limited" ||
        result.status === "transient" ||
        result.status === "suppressed"
      ) {
        await claim.release();
      }
      return result;
    },
  };
  if (provider.deleteIdentity) {
    metered.deleteIdentity = (identity: string) => provider.deleteIdentity!(identity);
  }
  if (provider.maxSendRate) {
    metered.maxSendRate = () => provider.maxSendRate!();
  }
  if (provider.sendQuota) {
    metered.sendQuota = () => provider.sendQuota!();
  }
  return metered;
}
