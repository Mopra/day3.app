import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkRateLimit,
  enforceRateLimit,
  clientIp,
  type RateLimitStore,
} from "../src/lib/rate-limit";
import { HttpError } from "../src/api/http";

// In-memory stand-in for the ioredis slice the limiter uses. Implements just
// enough fixed-window semantics (INCR + per-key TTL) to exercise the logic
// without a real Redis.
class FakeRedis implements RateLimitStore {
  private counts = new Map<string, number>();
  private ttls = new Map<string, number>();
  async incr(key: string): Promise<number> {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }
  async pexpire(key: string, ms: number): Promise<number> {
    this.ttls.set(key, ms);
    return 1;
  }
  async pttl(key: string): Promise<number> {
    if (!this.counts.has(key)) return -2;
    return this.ttls.get(key) ?? -1;
  }
}

// A store that always throws, to prove the limiter fails open.
class BrokenRedis implements RateLimitStore {
  async incr(): Promise<number> {
    throw new Error("ECONNREFUSED");
  }
  async pexpire(): Promise<number> {
    throw new Error("ECONNREFUSED");
  }
  async pttl(): Promise<number> {
    throw new Error("ECONNREFUSED");
  }
}

// A store whose commands never settle — mirrors a real ioredis connection with
// `maxRetriesPerRequest: null` while Redis is unreachable (the command is queued
// forever, never resolving or rejecting). The limiter must still fail open via
// its timeout rather than hang the request.
class HangingRedis implements RateLimitStore {
  incr(): Promise<number> {
    return new Promise<number>(() => {});
  }
  pexpire(): Promise<number> {
    return new Promise<number>(() => {});
  }
  pttl(): Promise<number> {
    return new Promise<number>(() => {});
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkRateLimit (fixed window)", () => {
  const rule = { limit: 3, windowMs: 60_000 };

  it("allows up to the limit then rejects the Nth+1 request", async () => {
    const store = new FakeRedis();
    for (let i = 0; i < rule.limit; i++) {
      const r = await checkRateLimit("test_email", "acc_1", store, rule);
      expect(r.allowed).toBe(true);
    }
    const rejected = await checkRateLimit("test_email", "acc_1", store, rule);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("isolates buckets per key (account/IP)", async () => {
    const store = new FakeRedis();
    for (let i = 0; i < rule.limit; i++) {
      await checkRateLimit("test_email", "acc_1", store, rule);
    }
    // A different account starts fresh.
    const other = await checkRateLimit("test_email", "acc_2", store, rule);
    expect(other.allowed).toBe(true);
  });

  it("isolates buckets per limit name", async () => {
    const store = new FakeRedis();
    for (let i = 0; i < rule.limit; i++) {
      await checkRateLimit("import", "acc_1", store, rule);
    }
    const otherLimit = await checkRateLimit("test_email", "acc_1", store, rule);
    expect(otherLimit.allowed).toBe(true);
  });

  it("fails open (allows) and logs when the store is unreachable", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await checkRateLimit("test_email", "acc_1", new BrokenRedis(), rule);
    expect(r.allowed).toBe(true);
    expect(errSpy).toHaveBeenCalled();
  });

  it("fails open (does not hang) when the store never responds", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // Short timeout so the test is fast; the real default is 1000ms.
    process.env.RATE_LIMIT_STORE_TIMEOUT_MS = "50";
    const started = Date.now();
    const r = await checkRateLimit("support", "acc_1", new HangingRedis(), rule);
    const elapsed = Date.now() - started;
    expect(r.allowed).toBe(true);
    expect(elapsed).toBeLessThan(1000);
    expect(errSpy).toHaveBeenCalled();
    delete process.env.RATE_LIMIT_STORE_TIMEOUT_MS;
  });
});

describe("enforceRateLimit", () => {
  const rule = { limit: 2, windowMs: 60_000 };

  it("throws HttpError(429) with a Retry-After header once the window is exhausted", async () => {
    // Drive the env-configured rule for test_email down to `rule.limit`.
    process.env.RATE_LIMIT_TEST_EMAIL = `${rule.limit}/60`;
    const store = new FakeRedis();
    // The first `limit` calls are allowed (no throw).
    for (let i = 0; i < rule.limit; i++) {
      await enforceRateLimit("test_email", "acc_1", store);
    }
    // The Nth+1 call within the window is rejected.
    let thrown: unknown;
    try {
      await enforceRateLimit("test_email", "acc_1", store);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    const httpErr = thrown as HttpError;
    expect(httpErr.status).toBe(429);
    expect(httpErr.headers?.["Retry-After"]).toBeDefined();
    expect(Number(httpErr.headers!["Retry-After"])).toBeGreaterThan(0);
    delete process.env.RATE_LIMIT_TEST_EMAIL;
  });
});

describe("env-configurable rule", () => {
  const KEY = "RATE_LIMIT_IMPORT";
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it("honours RATE_LIMIT_<NAME> over the default", async () => {
    process.env[KEY] = "1/60"; // one request per minute
    const store = new FakeRedis();
    const first = await checkRateLimit("import", "acc_1", store);
    const second = await checkRateLimit("import", "acc_1", store);
    expect(first.allowed).toBe(true);
    expect(second.allowed).toBe(false);
  });

  it("ignores a malformed value and uses the default", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env[KEY] = "garbage";
    const store = new FakeRedis();
    // Default import limit is 10 — the 1st request must be allowed.
    const r = await checkRateLimit("import", "acc_1", store);
    expect(r.allowed).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });
});

describe("domain_recheck limit (manual domain re-check)", () => {
  it("allows a burst up to the default then rejects further re-checks in the window", async () => {
    const store = new FakeRedis();
    // Default is 30/60 (headroom for the client's auto-poll plus manual clicks)
    // — every one of the first 30 must be allowed.
    for (let i = 0; i < 30; i++) {
      const r = await checkRateLimit("domain_recheck", "acc_1", store);
      expect(r.allowed).toBe(true);
    }
    const rejected = await checkRateLimit("domain_recheck", "acc_1", store);
    expect(rejected.allowed).toBe(false);
    expect(rejected.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("clientIp", () => {
  it("prefers the first x-forwarded-for entry", () => {
    const req = {
      headers: new Headers({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }),
    } as unknown as Parameters<typeof clientIp>[0];
    expect(clientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to a shared bucket when no IP header is present", () => {
    const req = { headers: new Headers() } as unknown as Parameters<typeof clientIp>[0];
    expect(clientIp(req)).toBe("unknown");
  });
});
