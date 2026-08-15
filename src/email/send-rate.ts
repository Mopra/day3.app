import { logger } from "../lib/logger";
import type { EmailProvider, SendEmailResult } from "./provider";
import { E_ACCOUNT_SUSPENDED, E_DAILY_LIMIT_EXCEEDED, E_SENDING_MISCONFIGURED } from "./ses";

// Paces outbound mail to the provider's per-second send-rate ceiling.
//
// SES enforces a maximum send *rate* (emails/second) separately from the 24-hour
// quota, and exceeding it returns TooManyRequestsException — which send-batch
// turns into a campaign-wide pause. Nothing in the send path used to bound the
// rate: a campaign fans out to SEND_LANES concurrent lanes, each sending as fast
// as the socket allows (~50/s at the defaults), so the opening seconds of a real
// campaign overran a fresh account's 14/s ceiling and stalled the campaign for
// 10+ minutes at a time. Throughput was never actually the constraint — this
// trades a burst we were never allowed to send for a steady rate we are.
//
// The limiter is GCRA ("virtual scheduling") held in Redis: one key stores the
// theoretical arrival time (TAT) of the next permitted send, and each caller
// atomically reserves the next slot and learns exactly how long to sleep before
// taking it. Consequences worth knowing:
//   - It lives in Redis, not in-process, because the ceiling belongs to the AWS
//     account: every lane, every worker replica, and campaign *and* transactional
//     traffic all draw down one shared budget.
//   - Slots are handed out in arrival order, so callers never poll and never
//     stampede after an idle gap.
//   - The wait for one call is bounded by (concurrent senders × interval), NOT by
//     how much mail is queued: a caller reserves exactly one slot at the moment
//     it asks. At the defaults (8 lanes, 14/s) the worst wait is ~0.5s, which is
//     what keeps graceful shutdown responsive — the send loop's abort check runs
//     between recipients, so a long pacer wait would delay a deploy.

// Redis key holding the next permitted send time, in microseconds. Namespaced
// like the worker heartbeat. Deliberately NOT per-account: SES rate-limits the
// AWS account, so tenants share one budget.
export const SEND_RATE_KEY = "day3:send-rate";

// Fallback ceiling when the provider *should* be able to report a rate but the
// lookup failed. AWS's standard fresh production grant; low enough to be safe on
// any real account, and a wrong-but-low guess only costs throughput while a
// wrong-but-high one costs a paused campaign.
export const DEFAULT_MAX_SEND_RATE = 14;

// Fraction of the provider's ceiling we actually target. SES measures the rate
// on its side over its own window, so evenly-paced sends can still bunch at
// their edge through ordinary network jitter. Spending 10% to stay off the line
// is cheaper than one throttle: a throttle costs a retry at best and a paused
// campaign at worst.
export const DEFAULT_SEND_RATE_MARGIN = 0.9;

// How long a discovered rate is trusted before it is looked up again. AWS raises
// an account's ceiling as its reputation builds, so a value pinned once at boot
// would leave the account permanently throttled to whatever it was on day one.
const RATE_REFRESH_MS = 60 * 60 * 1000;

// TTL on the pacer key. It only has to outlive the furthest slot the key can
// ever hold (concurrent senders × interval, i.e. seconds), so this is generous.
// Expiry mid-idle is harmless and correct: an absent key means "nothing is
// scheduled", and the next caller sends immediately.
const KEY_TTL_MS = 300_000;

// Hard bound on how long we wait for Redis before giving up and pacing nothing.
// Same reasoning as the rate limiter's (src/lib/rate-limit.ts): the shared
// producer connection runs with `maxRetriesPerRequest: null` because BullMQ
// requires it, which means a command issued while Redis is unreachable is queued
// and NEVER rejects — it hangs. Without this bound the fail-open path below is
// unreachable and a Redis outage stops all mail instead of merely unpacing it.
// Overridable via SEND_RATE_STORE_TIMEOUT_MS; a healthy round-trip is a few ms.
function storeTimeoutMs(): number {
  return Number(process.env.SEND_RATE_STORE_TIMEOUT_MS) || 2000;
}

// Reserve the next send slot and return how long the caller must wait for it.
//
// Redis's own TIME is the clock, so every worker replica paces against one
// timeline rather than its own (possibly skewed) host clock. Times are
// microseconds throughout: a Lua number is a double, and whole microseconds stay
// exact well past any timescale this runs on (µs since epoch is ~2^51). The
// stored value is formatted with %.0f rather than written as a bare number —
// Lua's own number→string conversion is %.14g, which would round a 16-digit
// microsecond timestamp and make the pacer drift.
//
// KEYS[1] pacer key · ARGV[1] interval µs · ARGV[2] key TTL ms → wait µs
const RESERVE_SLOT_LUA = `
local interval = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000000 + tonumber(clock[2])
local tat = tonumber(redis.call('GET', KEYS[1]) or '0')
if tat < now then tat = now end
redis.call('SET', KEYS[1], string.format('%.0f', tat + interval), 'PX', ttl)
return math.floor(tat - now)
`;

// Push the next permitted send time forward, so every in-flight sender backs off
// together instead of each discovering the same throttle on its own.
//
// KEYS[1] pacer key · ARGV[1] delay µs · ARGV[2] key TTL ms → 0
const BRAKE_LUA = `
local by = tonumber(ARGV[1])
local ttl = tonumber(ARGV[2])
local clock = redis.call('TIME')
local now = tonumber(clock[1]) * 1000000 + tonumber(clock[2])
local tat = tonumber(redis.call('GET', KEYS[1]) or '0')
if tat < now then tat = now end
redis.call('SET', KEYS[1], string.format('%.0f', tat + by), 'PX', ttl)
return 0
`;

// The slice of ioredis the pacer uses — kept narrow so tests can inject a fake,
// the same shape of seam as RateLimitStore. EVAL ships the script body on every
// call rather than EVALSHA'ing it; at one call per email that is a few hundred
// bytes against an email, and it keeps this interface to a single method.
export interface SendPaceStore {
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

export type SendPacer = {
  /** Blocks until this caller's slot is due. Resolves immediately when unpaced. */
  acquire(): Promise<void>;
  /** Delay every sender's next slot by `ms` (used after a provider throttle). */
  brake(ms: number): Promise<void>;
  /** Resolve the rate now, so startup can log it and the hot path never blocks. */
  warmUp(): Promise<number>;
  /** Sends per second currently being targeted; Infinity when unpaced. */
  rate(): number;
};

export type SendPacerOptions = {
  store: SendPaceStore;
  /**
   * The provider's own ceiling, if it can report one. Absent means the provider
   * has no rate limit worth pacing (the mock) and the pacer no-ops; present but
   * failing means we could not read a real ceiling and fall back conservatively.
   */
  discover?: () => Promise<number | null>;
  /** Explicit override; skips discovery entirely. */
  rate?: number;
  margin?: number;
  key?: string;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Race a store call against a timeout so a hung Redis surfaces as a rejection
// the caller can fail open on, instead of hanging the send forever.
function withTimeout<T>(op: Promise<T>): Promise<T> {
  const ms = storeTimeoutMs();
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`send pacer store did not respond within ${ms}ms`)),
      ms,
    );
    op.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// Float env knob with a default and hard bounds. NaN-safe for the same reason
// envInt is (src/queue/messages.ts): Number("14/s") is NaN, and a NaN rate would
// produce a NaN interval and hang every send on an infinite sleep.
export function envFloat(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

/**
 * Turn a provider ceiling into the rate we target. Exported for tests: the
 * margin and the floor are the difference between "paced" and "paced into
 * uselessness", and a regression here is invisible until a campaign crawls.
 */
export function effectiveRate(ceiling: number | null, margin: number): number {
  if (ceiling === null || !Number.isFinite(ceiling) || ceiling <= 0) {
    return DEFAULT_MAX_SEND_RATE * margin;
  }
  // Never pace below 1/s. A margin applied to an already-tiny ceiling (SES hands
  // sandbox accounts 1/s) would otherwise stretch a send out for no benefit —
  // below ~1/s the round-trip is the limit anyway.
  return Math.max(1, ceiling * margin);
}

export function createSendPacer(opts: SendPacerOptions): SendPacer {
  const key = opts.key ?? SEND_RATE_KEY;
  const margin = opts.margin ?? envFloat("SEND_RATE_MARGIN", DEFAULT_SEND_RATE_MARGIN, 0.1, 1);
  const override = opts.rate ?? envFloat("SES_MAX_SEND_RATE", 0, 0, 10_000);

  // Infinity = unpaced. That is the honest starting point for a provider that
  // reports no ceiling (mock), and for the moment before warmUp() has run: a
  // handful of unpaced sends at boot is a far smaller problem than blocking the
  // first send behind an API call to AWS.
  let current = Number.POSITIVE_INFINITY;
  let resolvedAt = 0;
  let inFlight: Promise<number> | null = null;
  let loggedStoreFailure = false;

  async function resolve(): Promise<number> {
    if (override > 0) {
      current = override * margin;
      resolvedAt = Date.now();
      return current;
    }
    if (!opts.discover) {
      current = Number.POSITIVE_INFINITY; // nothing to pace against
      resolvedAt = Date.now();
      return current;
    }
    try {
      const ceiling = await opts.discover();
      current = effectiveRate(ceiling, margin);
      if (ceiling === null) {
        logger.warn("provider reported no send-rate ceiling; using the default", {
          rate: current,
        });
      }
    } catch (err) {
      // Falling back rather than failing: a transient GetAccount error must not
      // stop mail, and the default is deliberately below any real ceiling.
      current = DEFAULT_MAX_SEND_RATE * margin;
      logger.warn("send-rate lookup failed; using the default", {
        error: err instanceof Error ? err.message : String(err),
        rate: current,
      });
    }
    resolvedAt = Date.now();
    return current;
  }

  // Refresh off the hot path: the caller keeps using the rate it already has
  // while the lookup runs. Single-flighted so 8 lanes crossing the staleness
  // boundary together make one API call, not eight.
  function refreshIfStale(): void {
    if (Date.now() - resolvedAt < RATE_REFRESH_MS || inFlight) return;
    inFlight = resolve().finally(() => {
      inFlight = null;
    });
    void inFlight.catch(() => {});
  }

  return {
    rate: () => current,

    async warmUp(): Promise<number> {
      const rate = await resolve();
      logger.info("outbound send pacing configured", {
        rate: Number.isFinite(rate) ? Number(rate.toFixed(2)) : "unpaced",
        margin,
        source: override > 0 ? "SES_MAX_SEND_RATE" : opts.discover ? "provider" : "none",
      });
      return rate;
    },

    async acquire(): Promise<void> {
      refreshIfStale();
      const rate = current;
      if (!Number.isFinite(rate) || rate <= 0) return; // unpaced provider
      const intervalUs = Math.max(1, Math.round(1_000_000 / rate));
      let waitUs = 0;
      try {
        const raw = await withTimeout(
          opts.store.eval(RESERVE_SLOT_LUA, 1, key, intervalUs, KEY_TTL_MS),
        );
        waitUs = typeof raw === "number" ? raw : Number(raw);
        if (!Number.isFinite(waitUs) || waitUs < 0) waitUs = 0;
      } catch (err) {
        // Fail OPEN, and only log the first one: this runs per email, so a Redis
        // outage would otherwise write a log line per send. Unpaced sending is
        // the pre-existing behaviour and the provider throttle still backstops it.
        if (!loggedStoreFailure) {
          loggedStoreFailure = true;
          logger.warn("send pacer unavailable; sending unpaced", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
        return;
      }
      loggedStoreFailure = false;
      if (waitUs > 0) await sleep(waitUs / 1000);
    },

    async brake(ms: number): Promise<void> {
      if (!Number.isFinite(current)) return;
      try {
        await withTimeout(opts.store.eval(BRAKE_LUA, 1, key, Math.round(ms * 1000), KEY_TTL_MS));
      } catch {
        // Best-effort: the caller's own backoff still applies.
      }
    },
  };
}

// --- The provider decorator -------------------------------------------------

// A throttle that pacing should have prevented, and that clears on its own in
// about a second. Everything else SES reports as `rate_limited` (daily quota
// exhausted, account suspended, config broken) is a wall no amount of waiting
// gets past inside one batch — those must reach the handler so it pauses the
// campaign and, where relevant, pages ops.
export function isTransientThrottle(result: SendEmailResult): boolean {
  if (result.status !== "rate_limited") return false;
  const err = result.error ?? "";
  return (
    !err.startsWith(E_DAILY_LIMIT_EXCEEDED) &&
    !err.startsWith(E_ACCOUNT_SUSPENDED) &&
    !err.startsWith(E_SENDING_MISCONFIGURED)
  );
}

// Retries for a transient throttle before giving up and letting the handler
// pause. Kept small and bounded: each attempt also brakes every other sender, so
// three is enough to ride out a momentary overrun, while a persistent throttle
// (a ceiling that dropped under us) still surfaces quickly instead of holding
// claimed rows past the sweep's stuck-lock window.
const MAX_THROTTLE_RETRIES = 3;
const THROTTLE_BACKOFF_MS = [1000, 2000, 4000];

/**
 * Wraps a provider so every send waits for its slot, and a throttle that slips
 * through is absorbed rather than escalated.
 *
 * This is the one place pacing is applied, deliberately: wrapping the provider
 * rather than the send loop means campaign batches, transactional sends, and
 * form confirmations are all paced by construction, and a future send path
 * cannot forget to opt in. Retrying inside here is safe for the same reason the
 * handlers may return a rate-limited recipient to `pending`: `rate_limited`
 * means the provider rejected the request *before* sending, so no retry of it
 * can duplicate an email. (Never widen this to other statuses — `failed` covers
 * ambiguous transport errors where the message may already be at SES.)
 */
export function withSendPacing(provider: EmailProvider, pacer: SendPacer): EmailProvider {
  const paced: EmailProvider = {
    async send(input) {
      let result: SendEmailResult | null = null;
      for (let attempt = 0; attempt <= MAX_THROTTLE_RETRIES; attempt++) {
        await pacer.acquire();
        result = await provider.send(input);
        if (!isTransientThrottle(result) || attempt === MAX_THROTTLE_RETRIES) return result;
        const backoff = THROTTLE_BACKOFF_MS[attempt];
        // Brake first: the other lanes are mid-flight against the same ceiling,
        // and slowing only this one just hands the next throttle to them.
        await pacer.brake(backoff);
        logger.warn("provider throttled a send; backing off and retrying", {
          attempt: attempt + 1,
          backoffMs: backoff,
          rate: pacer.rate(),
        });
        await sleep(backoff);
      }
      return result!;
    },
  };
  if (provider.deleteIdentity) {
    paced.deleteIdentity = (identity: string) => provider.deleteIdentity!(identity);
  }
  if (provider.maxSendRate) {
    paced.maxSendRate = () => provider.maxSendRate!();
  }
  return paced;
}
