import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  costMicroDollars,
  enforceAiBudget,
  normalizeUsage,
  readAiBudget,
  recordAiUsage,
  type AiBudgetStore,
} from "../src/lib/ai-budget";
import { aiAllowanceForPlan, type AiAllowance } from "../src/lib/plans-catalog";
import { HttpError } from "../src/api/http";

// In-memory stand-in for the ioredis slice the budget uses. Implements just
// enough semantics (INCRBY + per-key TTL + GET) to exercise the logic without a
// real Redis.
class FakeRedis implements AiBudgetStore {
  vals = new Map<string, number>();
  ttls = new Map<string, number>();
  async incrby(key: string, increment: number): Promise<number> {
    const next = (this.vals.get(key) ?? 0) + increment;
    this.vals.set(key, next);
    return next;
  }
  async pexpire(key: string, ms: number): Promise<number> {
    this.ttls.set(key, ms);
    return 1;
  }
  async pttl(key: string): Promise<number> {
    if (!this.vals.has(key)) return -2;
    return this.ttls.get(key) ?? -1;
  }
  async get(key: string): Promise<string | null> {
    const v = this.vals.get(key);
    return v === undefined ? null : String(v);
  }
}

// A store that always throws, to prove the budget fails open.
class BrokenRedis implements AiBudgetStore {
  async incrby(): Promise<number> {
    throw new Error("ECONNREFUSED");
  }
  async pexpire(): Promise<number> {
    throw new Error("ECONNREFUSED");
  }
  async pttl(): Promise<number> {
    throw new Error("ECONNREFUSED");
  }
  async get(): Promise<string | null> {
    throw new Error("ECONNREFUSED");
  }
}

// Bucket SIZES come from the plan (see lib/plans-catalog), so the tests pass an
// explicit allowance rather than pinning env. Only the window length and the
// token prices are env-tunable, and those stay pinned so the math is exact.
const ENV_KEYS = [
  "AI_BUDGET_WINDOW_HOURS",
  "AI_PRICE_INPUT_PER_MTOK",
  "AI_PRICE_OUTPUT_PER_MTOK",
] as const;
const saved: Record<string, string | undefined> = {};

// The full (10k-and-up) allowance: $0.30 per window, $2.00 per month.
const FULL: AiAllowance = { windowCredits: 30, monthlyCredits: 200 };

// A fixed instant so the monthly key/reset are deterministic.
const NOW = new Date("2026-06-15T12:00:00.000Z");

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.AI_BUDGET_WINDOW_HOURS = "5";
  process.env.AI_PRICE_INPUT_PER_MTOK = "3";
  process.env.AI_PRICE_OUTPUT_PER_MTOK = "15";
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  vi.restoreAllMocks();
});

describe("cost metering", () => {
  it("prices input and output tokens separately (µ$)", () => {
    // 1000 in * 3 + 1000 out * 15 = 18_000 µ$ = $0.018
    expect(costMicroDollars({ inputTokens: 1000, outputTokens: 1000 })).toBe(18_000);
  });

  it("tolerates the legacy prompt/completion token names", () => {
    expect(normalizeUsage({ promptTokens: 500, completionTokens: 250 })).toEqual({
      inputTokens: 500,
      outputTokens: 250,
    });
  });

  it("treats missing/garbage usage as zero cost", () => {
    expect(costMicroDollars(undefined)).toBe(0);
    expect(costMicroDollars({ inputTokens: null, outputTokens: undefined })).toBe(0);
  });
});

describe("readAiBudget", () => {
  it("reports a fresh account as unused and not exhausted", async () => {
    const snap = await readAiBudget("acc_1", FULL, new FakeRedis(), NOW);
    expect(snap.exhausted).toBe(false);
    expect(snap.percentUsed).toBe(0);
    expect(snap.limitCredits).toBe(30);
    expect(snap.reason).toBeNull();
  });

  it("tracks partial usage as a percentage of the window", async () => {
    const store = new FakeRedis();
    // $0.15 of a $0.30 window = 50%.
    await recordAiUsage("acc_1", { inputTokens: 0, outputTokens: 10_000 }, FULL, store, NOW);
    const snap = await readAiBudget("acc_1", FULL, store, NOW);
    expect(snap.percentUsed).toBe(50);
    expect(snap.exhausted).toBe(false);
  });

  it("marks the window exhausted once the budget is reached and reports a reset", async () => {
    const store = new FakeRedis();
    // 20_000 out * 15 = 300_000 µ$ = the full $0.30 window.
    await recordAiUsage("acc_1", { inputTokens: 0, outputTokens: 20_000 }, FULL, store, NOW);
    const snap = await readAiBudget("acc_1", FULL, store, NOW);
    expect(snap.exhausted).toBe(true);
    expect(snap.reason).toBe("window");
    expect(snap.percentUsed).toBe(100);
    expect(snap.resetsInSeconds).toBeGreaterThan(0);
  });

  it("isolates usage per account", async () => {
    const store = new FakeRedis();
    await recordAiUsage("acc_1", { inputTokens: 0, outputTokens: 20_000 }, FULL, store, NOW);
    const other = await readAiBudget("acc_2", FULL, store, NOW);
    expect(other.exhausted).toBe(false);
    expect(other.percentUsed).toBe(0);
  });

  it("fails open (not exhausted) when the store is unreachable", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const snap = await readAiBudget("acc_1", FULL, new BrokenRedis(), NOW);
    expect(snap.exhausted).toBe(false);
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("per-plan allowance", () => {
  // The same spend that leaves a 10k-tier org with headroom exhausts a starter
  // tier — the starter allowance is real, just smaller.
  it("sizes the window from the plan, so a starter tier runs out sooner", async () => {
    const starter = aiAllowanceForPlan("1k_plan");
    const store = new FakeRedis();
    // $0.12 of spend: inside the full $0.30 window, past the starter $0.10 one.
    await recordAiUsage("acc_1", { inputTokens: 0, outputTokens: 8_000 }, starter, store, NOW);

    expect((await readAiBudget("acc_1", starter, store, NOW)).exhausted).toBe(true);
    expect((await readAiBudget("acc_1", FULL, store, NOW)).exhausted).toBe(false);
  });

  it("gives the free tier a zero budget, so nothing is ever allowed", async () => {
    const free = aiAllowanceForPlan("free_org");
    const snap = await readAiBudget("acc_1", free, new FakeRedis(), NOW);
    // A zero window budget can't be "exceeded" by the meter (0 > 0 is false), so
    // the free tier is held out by planHasAI at the route, not by the budget.
    expect(snap.limitCredits).toBe(0);
  });
});

describe("monthly backstop", () => {
  it("blocks via the monthly ceiling even when the window has headroom", async () => {
    // Window effectively unlimited so the month is the binding limit.
    const allowance: AiAllowance = { windowCredits: 100_000, monthlyCredits: 1 };
    const store = new FakeRedis();
    // 1000 out * 15 = 15_000 µ$ > the $0.01 monthly cap.
    await recordAiUsage("acc_1", { inputTokens: 0, outputTokens: 1000 }, allowance, store, NOW);
    const snap = await readAiBudget("acc_1", allowance, store, NOW);
    expect(snap.exhausted).toBe(true);
    expect(snap.reason).toBe("month");
    // Resets at the next month boundary — well over an hour out.
    expect(snap.resetsInSeconds).toBeGreaterThan(3600);
  });

  it("does not record or enforce a monthly cap when disabled (0)", async () => {
    const allowance: AiAllowance = { windowCredits: 100_000, monthlyCredits: 0 };
    const store = new FakeRedis();
    await recordAiUsage("acc_1", { inputTokens: 1000, outputTokens: 1000 }, allowance, store, NOW);
    const snap = await readAiBudget("acc_1", allowance, store, NOW);
    expect(snap.exhausted).toBe(false);
    // No monthly key was written.
    const monthKeys = [...store.vals.keys()].filter((k) => k.startsWith("aibudget:m:"));
    expect(monthKeys).toHaveLength(0);
  });
});

describe("recordAiUsage", () => {
  it("accumulates across calls and seeds the window TTL on first write", async () => {
    const store = new FakeRedis();
    await recordAiUsage("acc_1", { inputTokens: 0, outputTokens: 5000 }, FULL, store, NOW); // $0.075
    await recordAiUsage("acc_1", { inputTokens: 0, outputTokens: 5000 }, FULL, store, NOW); // $0.15 total
    const snap = await readAiBudget("acc_1", FULL, store, NOW);
    expect(snap.percentUsed).toBe(50);
    // TTL was set to the 5h window (in ms).
    expect(store.ttls.get("aibudget:w:acc_1")).toBe(5 * 3_600_000);
  });

  it("is a no-op for zero-cost usage", async () => {
    const store = new FakeRedis();
    await recordAiUsage("acc_1", { inputTokens: 0, outputTokens: 0 }, FULL, store, NOW);
    expect(store.vals.size).toBe(0);
  });

  it("never throws when the store is unreachable", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(
      recordAiUsage("acc_1", { inputTokens: 100, outputTokens: 100 }, FULL, new BrokenRedis(), NOW),
    ).resolves.toBeUndefined();
    expect(errSpy).toHaveBeenCalled();
  });
});

describe("enforceAiBudget", () => {
  it("is a no-op while there is headroom", async () => {
    const store = new FakeRedis();
    await recordAiUsage("acc_1", { inputTokens: 0, outputTokens: 5000 }, FULL, store, NOW);
    await expect(enforceAiBudget("acc_1", FULL, store, NOW)).resolves.toBeUndefined();
  });

  it("throws HttpError(429) with a Retry-After header once the budget is spent", async () => {
    const store = new FakeRedis();
    await recordAiUsage("acc_1", { inputTokens: 0, outputTokens: 20_000 }, FULL, store, NOW);
    let thrown: unknown;
    try {
      await enforceAiBudget("acc_1", FULL, store, NOW);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(HttpError);
    const httpErr = thrown as HttpError;
    expect(httpErr.status).toBe(429);
    expect(Number(httpErr.headers?.["Retry-After"])).toBeGreaterThan(0);
  });

  it("points a starter tier at an upgrade when its MONTHLY allowance is spent", async () => {
    const starter = aiAllowanceForPlan("1k_plan");
    const store = new FakeRedis();
    // Blow past the starter monthly cap in one go.
    await recordAiUsage("acc_1", { inputTokens: 0, outputTokens: 200_000 }, starter, store, NOW);
    await expect(enforceAiBudget("acc_1", starter, store, NOW)).rejects.toThrow(/upgrade your plan/i);
  });

  it("does not dangle an upgrade at a tier already on the full allowance", async () => {
    const store = new FakeRedis();
    await recordAiUsage("acc_1", { inputTokens: 0, outputTokens: 200_000 }, FULL, store, NOW);
    let thrown: unknown;
    try {
      await enforceAiBudget("acc_1", FULL, store, NOW);
    } catch (err) {
      thrown = err;
    }
    expect((thrown as HttpError).message).toMatch(/resets at the start of next month\.$/);
  });
});
