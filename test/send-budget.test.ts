import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  ALERT_LEVELS,
  SEND_BUDGET_ALERT_PREFIX,
  alertsFor,
  budgetRefusal,
  bucketKey,
  bulkCeilingFor,
  createSendBudget,
  dailyLimitPauseReason,
  estimateRecovery,
  parseRetryAt,
  windowKeys,
  withSendBudget,
  type SendBudgetStore,
} from "../src/email/send-budget";
import { E_DAILY_LIMIT_EXCEEDED } from "../src/email/ses";
import { logger } from "../src/lib/logger";
import { resumePausedCampaigns } from "../src/queue/cron";
import { campaignRecipients, campaigns } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import {
  FakeQueue,
  TEST_EMAILS,
  asQueue,
  seedAccount,
  seedAudience,
  seedCampaign,
  seedDomain,
  seedSubscribers,
  testDb,
} from "./helpers";
import type { EmailProvider, SendEmailResult } from "../src/email/provider";

const HOUR = 3_600_000;

// In-memory stand-in for the ioredis slice the budget uses. The eval branches
// mirror CONSUME_LUA / RELEASE_LUA / ALERT_LUA step for step, so a test that
// passes here is testing the same arithmetic Redis runs.
class FakeBudgetStore implements SendBudgetStore {
  counters = new Map<string, number>();
  locks = new Set<string>();
  fail = false;
  evals = 0;

  async eval(script: string, _numKeys: number, ...args: (string | number)[]): Promise<unknown> {
    if (this.fail) throw new Error("redis is down");
    this.evals++;
    const key = String(args[0]);
    if (script.includes("'NX'")) {
      if (this.locks.has(key)) return 0;
      this.locks.add(key);
      return 1;
    }
    if (script.includes("DECR")) {
      const current = this.counters.get(key) ?? 0;
      if (current > 0) this.counters.set(key, current - 1);
      return 0;
    }
    const limit = Number(args[1]);
    const current = this.counters.get(key) ?? 0;
    if (limit >= 0 && current >= limit) return -1;
    this.counters.set(key, current + 1);
    return current + 1;
  }

  async mget(...keys: string[]): Promise<(string | null)[]> {
    if (this.fail) throw new Error("redis is down");
    return keys.map((key) => {
      const value = this.counters.get(key);
      return value === undefined ? null : String(value);
    });
  }
}

class FakeProvider implements EmailProvider {
  sends = 0;
  constructor(private result: SendEmailResult = { provider: "ses", status: "sent" }) {}
  async send(): Promise<SendEmailResult> {
    this.sends++;
    return this.result;
  }
}

afterEach(() => vi.restoreAllMocks());

describe("recovery estimate", () => {
  const now = 100 * HOUR;

  it("dates recovery from when the oldest sends leave the rolling window", () => {
    // 24h of history; the oldest hour still inside the window holds 300 sends.
    const buckets = [
      { start: now - 24 * HOUR, count: 300 },
      { start: now - 23 * HOUR, count: 500 },
    ];
    // One slot comes back when the first bucket has fully aged out: its last
    // send happens at start+1h and stops counting 24h after that.
    expect(estimateRecovery(buckets, now, 1)).toBe(now - 24 * HOUR + 25 * HOUR);
    // More than that bucket holds has to wait for the next one.
    expect(estimateRecovery(buckets, now, 400)).toBe(now - 23 * HOUR + 25 * HOUR);
  });

  it("ignores buckets that have already left the window", () => {
    const buckets = [
      { start: now - 30 * HOUR, count: 1000 }, // gone: start + 25h < now
      { start: now - 2 * HOUR, count: 10 },
    ];
    expect(estimateRecovery(buckets, now, 1)).toBe(now - 2 * HOUR + 25 * HOUR);
  });

  it("returns null rather than inventing a time it cannot promise", () => {
    expect(estimateRecovery([{ start: now - HOUR, count: 5 }], now, 50)).toBeNull();
    expect(estimateRecovery([], now, 1)).toBeNull();
  });
});

describe("thresholds and messages", () => {
  it("holds back a fraction of the ceiling, with a floor for small ones", () => {
    expect(bulkCeilingFor(50_000)).toBe(49_000); // 2%
    expect(bulkCeilingFor(10_000)).toBe(9_500); // the 500 floor beats 2%
    expect(bulkCeilingFor(200)).toBe(0); // tiny ceiling: bulk waits its turn
  });

  it("reports the highest crossed alert level first", () => {
    expect(alertsFor(0.95)[0]).toEqual(ALERT_LEVELS[1]);
    expect(alertsFor(0.99)[0]).toEqual(ALERT_LEVELS[2]);
    expect(alertsFor(0.5)).toEqual([]);
  });

  it("round-trips the retry estimate through the error string", () => {
    const at = Date.parse("2026-09-21T12:00:00.000Z");
    const refusal = budgetRefusal(at);
    expect(refusal.startsWith(E_DAILY_LIMIT_EXCEEDED)).toBe(true);
    expect(parseRetryAt(refusal)?.getTime()).toBe(at);
    expect(parseRetryAt(budgetRefusal(null))).toBeNull();
    expect(parseRetryAt(undefined)).toBeNull();
    expect(parseRetryAt("TooManyRequestsException")).toBeNull();
  });

  it("tells the user nothing is lost, and whose ceiling this is", () => {
    const now = new Date("2026-09-21T09:00:00.000Z");
    const text = dailyLimitPauseReason(new Date("2026-09-21T12:00:00.000Z"), now);
    expect(text).toContain("nothing is lost");
    expect(text).toContain("about 3 hours");
    expect(text).not.toContain("your limit");
    expect(dailyLimitPauseReason(null, now)).toContain("as soon as capacity frees up");
  });

  it("keys the window by the hour and covers a full 24", () => {
    const keys = windowKeys(100 * HOUR);
    expect(keys).toHaveLength(24);
    expect(keys[23]).toBe(bucketKey(100 * HOUR));
    expect(keys[0]).toBe(bucketKey(77 * HOUR));
  });
});

describe("the daily budget", () => {
  const at = 100 * HOUR;
  const budgetWith = (store: SendBudgetStore, quota: { max24h: number; sent24h: number } | null) =>
    createSendBudget({
      store,
      quota: async () => (quota ? { ...quota, maxSendRate: null } : null),
      now: () => at,
    });

  it("holds bulk at the reserve while transactional keeps flowing", async () => {
    const store = new FakeBudgetStore();
    // Ceiling 1,000 with a 500 floor reserve: bulk may use 500.
    const budget = budgetWith(store, { max24h: 1000, sent24h: 0 });
    await budget.warmUp();

    for (let i = 0; i < 500; i++) {
      expect((await budget.claim("bulk")).ok).toBe(true);
    }
    const refused = await budget.claim("bulk");
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.startsWith(E_DAILY_LIMIT_EXCEEDED)).toBe(true);

    // The reserve exists for exactly this: the confirmation still goes out.
    expect((await budget.claim("transactional")).ok).toBe(true);

    const status = await budget.status();
    expect(status.bulkHeadroom).toBe(0);
    expect(status.headroom).toBeGreaterThan(0);
  });

  it("gives a claimed slot back when the send did not happen", async () => {
    const store = new FakeBudgetStore();
    const budget = budgetWith(store, { max24h: 1000, sent24h: 0 });
    await budget.warmUp();

    const claim = await budget.claim("bulk");
    expect(claim.ok).toBe(true);
    expect(store.counters.get(bucketKey(at))).toBe(1);
    if (claim.ok) await claim.release();
    expect(store.counters.get(bucketKey(at))).toBe(0);
  });

  it("counts mail the worker never saw, via the provider's own number", async () => {
    const store = new FakeBudgetStore();
    // Our ledger is empty but SES says 900 of the 1,000 are gone (web-tier
    // transactional sends). Bulk has no room at all.
    const budget = budgetWith(store, { max24h: 1000, sent24h: 900 });
    await budget.warmUp();

    expect((await budget.claim("bulk")).ok).toBe(false);
    expect((await budget.status()).sent24h).toBe(900);
  });

  it("sends unmetered when the ceiling cannot be read", async () => {
    const store = new FakeBudgetStore();
    const budget = budgetWith(store, null);
    await budget.warmUp();

    for (let i = 0; i < 50; i++) expect((await budget.claim("bulk")).ok).toBe(true);
    const status = await budget.status();
    expect(status.known).toBe(false);
    expect(status.bulkHeadroom).toBe(Number.POSITIVE_INFINITY);
  });

  it("fails open when the store is unreachable", async () => {
    const store = new FakeBudgetStore();
    const budget = budgetWith(store, { max24h: 1000, sent24h: 0 });
    await budget.warmUp();
    store.fail = true;

    // Redis being down must never be the reason an email doesn't go out.
    expect((await budget.claim("bulk")).ok).toBe(true);
  });

  it("pages once per threshold, not once per refresh", async () => {
    const store = new FakeBudgetStore();
    const paged = vi.spyOn(logger, "reportError").mockResolvedValue();
    const budget = budgetWith(store, { max24h: 1000, sent24h: 950 });

    await budget.warmUp();
    await budget.warmUp();

    expect(paged).toHaveBeenCalledTimes(1);
    expect(paged.mock.calls[0][0]).toContain("95%");
    // Dedup is held in Redis so every replica shares the one page.
    expect(store.locks.has(`${SEND_BUDGET_ALERT_PREFIX}0.9`)).toBe(true);
  });

  it("stays quiet below the first level", async () => {
    const store = new FakeBudgetStore();
    const paged = vi.spyOn(logger, "reportError").mockResolvedValue();
    await budgetWith(store, { max24h: 1000, sent24h: 500 }).warmUp();
    expect(paged).not.toHaveBeenCalled();
  });
});

describe("the metered provider", () => {
  const at = 100 * HOUR;

  it("never reaches the provider once bulk is held", async () => {
    const store = new FakeBudgetStore();
    const budget = createSendBudget({
      store,
      quota: async () => ({ max24h: 500, sent24h: 500, maxSendRate: null }),
      now: () => at,
    });
    await budget.warmUp();
    const provider = new FakeProvider();
    const metered = withSendBudget(provider, budget);

    const result = await metered.send({
      accountId: "acc_1",
      fromEmail: "a@day3.app",
      fromName: "Day3",
      toEmail: "b@example.com",
      subject: "hi",
      html: "<p>hi</p>",
      kind: "bulk",
    });

    expect(provider.sends).toBe(0);
    expect(result.status).toBe("rate_limited");
    expect(result.error?.startsWith(E_DAILY_LIMIT_EXCEEDED)).toBe(true);
  });

  it("releases the slot when the provider rejected the send", async () => {
    const store = new FakeBudgetStore();
    const budget = createSendBudget({
      store,
      quota: async () => ({ max24h: 10_000, sent24h: 0, maxSendRate: null }),
      now: () => at,
    });
    await budget.warmUp();
    const provider = new FakeProvider({ provider: "ses", status: "suppressed" });
    const metered = withSendBudget(provider, budget);

    await metered.send({
      accountId: "acc_1",
      fromEmail: "a@day3.app",
      fromName: "Day3",
      toEmail: "b@example.com",
      subject: "hi",
      html: "<p>hi</p>",
      kind: "bulk",
    });

    expect(provider.sends).toBe(1);
    expect(store.counters.get(bucketKey(at))).toBe(0);
  });
});

// The other half of "fail softly": a campaign held by the ceiling has to come
// back on its own, and it has to come back when there is actually room.
describe("resuming a campaign held by the daily ceiling", () => {
  const budgetStub = (bulkHeadroom: number, known = true) => ({
    claim: async () => ({ ok: true as const, release: async () => {} }),
    warmUp: async () => {
      throw new Error("not used");
    },
    status: async () => ({
      known,
      max24h: 50_000,
      sent24h: 49_000,
      headroom: 1_000,
      bulkHeadroom,
      usedFraction: 0.98,
      bulkRecoversAt: null,
      refreshedAt: nowIso(),
    }),
  });

  async function pausedCampaign(pausedMinutesAgo: number) {
    const db = await testDb();
    const account = await seedAccount(db, {
      currentPeriodStart: nowIso(),
      currentPeriodEnd: new Date(Date.now() + 10 * 86_400_000).toISOString(),
    });
    const domain = await seedDomain(db, account.id);
    const audience = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, audience.id, TEST_EMAILS);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "paused",
    });
    await db
      .update(campaigns)
      .set({
        pausedCode: "daily_limit",
        pausedReason: "held",
        updatedAt: new Date(Date.now() - pausedMinutesAgo * 60_000).toISOString(),
      })
      .where(eq(campaigns.id, campaign.id));
    await db.insert(campaignRecipients).values(
      ["a@example.com", "b@example.com"].map((email) => ({
        id: newId("rcp"),
        campaignId: campaign.id,
        accountId: account.id,
        email,
        status: "pending" as const,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      })),
    );
    return { db, campaign };
  }

  it("resumes as soon as headroom is back, without waiting out the cool-down", async () => {
    const { db, campaign } = await pausedCampaign(5);
    const queue = new FakeQueue();

    const resumed = await resumePausedCampaigns(
      db,
      asQueue(queue),
      new Date(),
      budgetStub(5_000),
    );

    expect(resumed).toBe(1);
    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sending");
    expect(queue.messages.some((m) => m.type === "send_campaign_batch")).toBe(true);
  });

  it("keeps holding while there is still no room, however long it has waited", async () => {
    const { db, campaign } = await pausedCampaign(12 * 60);
    const queue = new FakeQueue();

    const resumed = await resumePausedCampaigns(db, asQueue(queue), new Date(), budgetStub(0));

    expect(resumed).toBe(0);
    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("paused");
    expect(fresh?.pausedCode).toBe("daily_limit");
  });

  it("falls back to the cool-down when no budget can be read", async () => {
    const { db, campaign } = await pausedCampaign(12 * 60);
    const queue = new FakeQueue();

    const resumed = await resumePausedCampaigns(db, asQueue(queue), new Date(), budgetStub(0, false));

    expect(resumed).toBe(1);
    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sending");
  });
});
