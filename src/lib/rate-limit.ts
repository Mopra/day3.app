import type { NextRequest } from "next/server";
import { HttpError } from "@/api/http";
import { getRedisConnection } from "@/queue/producer";

// Redis-backed fixed-window rate limiter. Sensitive endpoints (CSV import,
// campaign create/submit, test-email send, the public unsubscribe lookup, and
// the Cloudflare OAuth start) are otherwise unbounded per account/IP — a cost,
// abuse, and DoS surface (real SES sends, queue/Redis flooding, storage fill).
//
// Design choices:
//   - Fixed window via INCR + EXPIRE: one round-trip on the hot path, cheap and
//     good enough for abuse throttling (a small burst at a window boundary is
//     acceptable; we are not metering billing).
//   - Keyed by account_id and/or IP so a single tenant or source can't exhaust
//     shared resources. Public (unauthenticated) routes key by IP only.
//   - Fails OPEN: if Redis is unreachable the request is allowed (the app must
//     not hard-fail on a limiter outage) but the condition is logged so it is
//     visible. The limiter is a guard rail, not an auth boundary.

// The slice of ioredis we use — kept narrow so tests can inject a fake.
export interface RateLimitStore {
  incr(key: string): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
}

export type RateLimitRule = {
  /** Max requests permitted per window. */
  limit: number;
  /** Window length in milliseconds. */
  windowMs: number;
};

// Each named limit reads `RATE_LIMIT_<NAME>` ("limit/windowSeconds", e.g.
// "5/60") from the env, falling back to the safe default below. Defaults are
// deliberately generous for normal use but bound abuse.
const DEFAULTS: Record<string, RateLimitRule> = {
  // CSV import: 5 MB upload + a queue job each. Tight.
  import: { limit: 10, windowMs: 60_000 },
  // Campaign create.
  campaign_create: { limit: 30, windowMs: 60_000 },
  // Test-email: triggers a real SES send.
  test_email: { limit: 5, windowMs: 60_000 },
  // Campaign submit → review pipeline.
  campaign_submit: { limit: 20, windowMs: 60_000 },
  // Public unsubscribe lookup/confirm (unauthenticated, keyed by IP).
  unsubscribe: { limit: 60, windowMs: 60_000 },
  // Cloudflare OAuth connect start.
  oauth_connect: { limit: 20, windowMs: 60_000 },
  // Manual domain re-check: each hit calls SES GetEmailIdentity (and possibly a
  // DoH lookup). Generous enough for impatient clicking, bounded against abuse.
  domain_recheck: { limit: 12, windowMs: 60_000 },
};

function parseRule(name: string): RateLimitRule {
  const fallback = DEFAULTS[name];
  const raw = process.env[`RATE_LIMIT_${name.toUpperCase()}`];
  if (!raw) return fallback;
  // Format: "<limit>/<windowSeconds>", e.g. "5/60".
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw);
  if (!match) {
    console.warn(
      `[rate-limit] ignoring malformed RATE_LIMIT_${name.toUpperCase()}="${raw}" ` +
        `(expected "<limit>/<windowSeconds>"); using default`,
    );
    return fallback;
  }
  const limit = Number(match[1]);
  const windowMs = Number(match[2]) * 1000;
  if (limit <= 0 || windowMs <= 0) return fallback;
  return { limit, windowMs };
}

export type RateLimitResult = {
  allowed: boolean;
  /** Seconds the caller should wait before retrying (0 when allowed). */
  retryAfterSeconds: number;
};

/**
 * Increment the fixed-window counter for `key` and decide if the request is
 * allowed. Fails open (allowed=true) when the store throws — and logs it.
 */
export async function checkRateLimit(
  name: string,
  key: string,
  store: RateLimitStore = getRedisConnection(),
  rule: RateLimitRule = parseRule(name),
): Promise<RateLimitResult> {
  const redisKey = `ratelimit:${name}:${key}`;
  try {
    const count = await store.incr(redisKey);
    if (count === 1) {
      // First hit in this window — set the TTL that defines the window.
      await store.pexpire(redisKey, rule.windowMs);
    }
    if (count <= rule.limit) {
      return { allowed: true, retryAfterSeconds: 0 };
    }
    let ttl = await store.pttl(redisKey);
    // pttl: -1 = no expiry set (lost the EXPIRE race), -2 = key gone.
    if (ttl < 0) {
      await store.pexpire(redisKey, rule.windowMs);
      ttl = rule.windowMs;
    }
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(ttl / 1000)) };
  } catch (err) {
    // Fail open: a limiter outage must not take down the endpoint, but it must
    // be visible.
    console.error(`[rate-limit] store unreachable for ${redisKey}; failing open`, err);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/**
 * Enforce a rate limit, throwing HttpError(429) with a Retry-After header and a
 * clear JSON error when the window is exhausted. No-op when allowed.
 */
export async function enforceRateLimit(
  name: string,
  key: string,
  store?: RateLimitStore,
): Promise<void> {
  const result = await checkRateLimit(name, key, store);
  if (!result.allowed) {
    throw new HttpError(429, "Too many requests. Please slow down and try again shortly.", {
      "Retry-After": String(result.retryAfterSeconds),
    });
  }
}

// Best-effort client IP from the standard proxy headers (Vercel sets
// x-forwarded-for). Falls back to a constant so the limiter still applies a
// shared bucket rather than silently disabling itself.
export function clientIp(req: NextRequest): string {
  const fwd = req.headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0].trim();
  return req.headers.get("x-real-ip")?.trim() || "unknown";
}
