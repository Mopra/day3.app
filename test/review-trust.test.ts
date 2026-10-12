// Review trust: which accounts get the AI pass on every new transactional shape,
// and which are sampled. See src/services/review-trust.ts for the design.
//
// The rule these tests hold: sampling only ever saves a model call. It never
// skips the deterministic floor, never survives a demotion, and a sampled-out
// shape is reviewed by the AI the next time it is sent from an account that has
// lost its trust.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { accounts, contentReviews, transactionalEmails, type Account } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { isBlocking, reviewAndStoreContent } from "../src/services/content-review";
import type { AiRiskVerdict } from "../src/services/risk-ai";
import {
  getReviewTrust,
  invalidateReviewTrust,
  resetReviewTrustCache,
  shouldRunAiReview,
  TRUST_MIN_AI_CLEAN,
  TRUST_MIN_DELIVERED,
  TRUSTED_SAMPLE_EVERY,
  type ReviewTrust,
} from "../src/services/review-trust";
import { seedAccount, testDb } from "./helpers";

const CLEAN = {
  subject: "Your weekly uptime report",
  fromEmail: "alerts@monitor.test.co",
  fromName: "Monitor",
  sendingDomain: "monitor.test.co",
  html: "<p>All 12 of your sites were up this week.</p>",
  text: null,
};

// The September 2026 phishing payload, trimmed (see test/content-review.test.ts).
const HOTDOC_PHISH = {
  subject: "Please Confirm Your Medicare Billing and Payment Information",
  fromEmail: "news@globalcitiys.com",
  fromName: "HotDoc",
  sendingDomain: "globalcitiys.com",
  html: `
    <div>
      <a href="https://www.hotdoc.com.au" title="HotDoc">
        <img alt="HotDoc" src="https://d1l6ddaqkjdc5s.cloudfront.net/assets/logo-email.png" />
      </a>
      <p>Hi Customer,</p>
      <p>To make sure your details are ready, please sign in to your account and review your pay back profile.</p>
      <a href="https://johnnyalfredosteamwfea48.myclickfunnels.com/hotdoc">Sign In to HotDoc</a>
      <img src="https://u7465326.ct.sendgrid.net/wf/open?upn=u001.7-2FXfiwRL03oG" />
      <p>Thanks, HotDoc. www.hotdoc.com.au</p>
    </div>`,
  text: null,
};

function verdict(overrides: Partial<AiRiskVerdict> = {}): AiRiskVerdict {
  return {
    riskLevel: "low",
    categories: [],
    rationale: "Looks fine.",
    guidance: [],
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    ...overrides,
  };
}

async function seedDelivered(db: Db, accountId: string, n: number) {
  const now = nowIso();
  const rows = Array.from({ length: n }, () => ({
    id: newId("eml"),
    accountId,
    fromEmail: "alerts@monitor.test.co",
    to: ["someone@example.com"],
    subject: "Alert",
    status: "delivered" as const,
    sentAt: now,
    createdAt: now,
    updatedAt: now,
  }));
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(transactionalEmails).values(rows.slice(i, i + 500));
  }
}

async function seedReviews(
  db: Db,
  accountId: string,
  n: number,
  overrides: Partial<typeof contentReviews.$inferInsert> = {},
) {
  const now = nowIso();
  await db.insert(contentReviews).values(
    Array.from({ length: n }, () => ({
      id: newId("cvw"),
      accountId,
      fingerprint: newId("fp"),
      riskLevel: "low",
      riskScore: 0,
      categoriesJson: "[]",
      summary: "ok",
      subject: "s",
      fromEmail: "alerts@monitor.test.co",
      aiReview: "reviewed",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })),
  );
}

async function seedTrusted(db: Db, overrides: Partial<Account> = {}): Promise<Account> {
  const account = await seedAccount(db, overrides);
  await seedDelivered(db, account.id, TRUST_MIN_DELIVERED);
  await seedReviews(db, account.id, TRUST_MIN_AI_CLEAN);
  return account;
}

const always = () => 0;
const never = () => 0.999;

describe("getReviewTrust", () => {
  let db: Db;
  beforeEach(async () => {
    db = await testDb();
    resetReviewTrustCache();
  });

  it("puts an account inside the ramp in `new`", async () => {
    const account = await seedAccount(db, { rampLiftedAt: null, createdAt: nowIso() });
    await seedDelivered(db, account.id, TRUST_MIN_DELIVERED);
    await seedReviews(db, account.id, TRUST_MIN_AI_CLEAN);
    const trust = await getReviewTrust(db, account);
    expect(trust.tier).toBe("new");
    expect(trust.sampleEvery).toBe(1);
    expect(trust.reasons).toContain("Still inside the new-account period");
  });

  it("keeps an established account with little history in `new`", async () => {
    const account = await seedAccount(db);
    await seedDelivered(db, account.id, 312);
    const trust = await getReviewTrust(db, account);
    expect(trust.tier).toBe("new");
    expect(trust.stats.deliveredCapped).toBe(312);
    expect(trust.reasons).toContain("312 of 1,000 delivered emails");
    expect(trust.reasons).toContain("0 of 25 clean AI reviews");
  });

  it("trusts an account with enough delivered mail and clean AI reviews", async () => {
    const account = await seedTrusted(db);
    const trust = await getReviewTrust(db, account);
    expect(trust.tier).toBe("trusted");
    expect(trust.sampleEvery).toBe(TRUSTED_SAMPLE_EVERY);
    expect(trust.stats.deliveredCapped).toBe(TRUST_MIN_DELIVERED);
    expect(trust.stats.aiClean).toBe(TRUST_MIN_AI_CLEAN);
    expect(trust.stats.lastFlaggedAt).toBeNull();
  });

  it("keeps trusting an account with one high verdict among many clean ones", async () => {
    // The model's false-positive floor: Exit1.dev drew 4 `high` in ~500 AI
    // reviews in a week, all honest SSL and uptime alerts.
    const account = await seedTrusted(db);
    await seedReviews(db, account.id, 1, { riskLevel: "high" });
    const trust = await getReviewTrust(db, account);
    expect(trust.tier).toBe("trusted");
    expect(trust.stats.lastFlaggedAt).not.toBeNull();
  });

  it("watches a pattern: 3 flagged at 5% or more of the window's AI reviews", async () => {
    const account = await seedTrusted(db); // 25 clean AI reviews in the window
    await seedReviews(db, account.id, 2, { riskLevel: "high" });
    await seedReviews(db, account.id, 1, { riskLevel: "blocked" });
    const trust = await getReviewTrust(db, account);
    expect(trust.tier).toBe("watch");
    expect(trust.sampleEvery).toBe(1);
    expect(trust.reasons).toContain("3 of 28 AI reviews flagged in the last 30 days (11%)");
  });

  it("keeps trusting 3 flagged below 5% of the window's AI reviews", async () => {
    const account = await seedTrusted(db);
    await seedReviews(db, account.id, 40); // 65 clean + 3 flagged = 68, 4.4%
    await seedReviews(db, account.id, 3, { riskLevel: "high" });
    expect((await getReviewTrust(db, account)).tier).toBe("trusted");
  });

  it("uses the count alone when the window has no AI reviews", async () => {
    const account = await seedAccount(db);
    await seedDelivered(db, account.id, TRUST_MIN_DELIVERED);
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    await seedReviews(db, account.id, TRUST_MIN_AI_CLEAN, { createdAt: old, updatedAt: old });
    await seedReviews(db, account.id, 2, { riskLevel: "high", aiReview: "sampled_out" });
    expect((await getReviewTrust(db, account)).tier).toBe("trusted");

    await seedReviews(db, account.id, 1, { riskLevel: "high", aiReview: "sampled_out" });
    invalidateReviewTrust(account.id);
    const trust = await getReviewTrust(db, account);
    expect(trust.tier).toBe("watch");
    expect(trust.reasons).toContain("3 content reviews flagged in the last 30 days");
  });

  it("watches on any phishing pair in the window", async () => {
    const account = await seedTrusted(db);
    await seedReviews(db, account.id, 1, { riskLevel: "blocked", hardBlock: true });
    const trust = await getReviewTrust(db, account);
    expect(trust.tier).toBe("watch");
    expect(trust.reasons.join(" ")).toMatch(/A phishing pair was refused on \d{4}-\d{2}-\d{2}/);
  });

  it("ignores a flag older than the lookback window", async () => {
    const account = await seedTrusted(db);
    const old = new Date(Date.now() - 45 * 86_400_000).toISOString();
    await seedReviews(db, account.id, 1, { riskLevel: "blocked", createdAt: old, updatedAt: old });
    expect((await getReviewTrust(db, account)).tier).toBe("trusted");
  });

  it("watches a risk-paused account", async () => {
    const account = await seedTrusted(db, { riskStatus: "paused", sendingEnabled: false });
    const trust = await getReviewTrust(db, account);
    expect(trust.tier).toBe("watch");
    expect(trust.reasons[0]).toMatch(/risk status is paused/);
  });

  it("caches until invalidated", async () => {
    const account = await seedTrusted(db);
    const first = await getReviewTrust(db, account);
    await seedReviews(db, account.id, 1, { riskLevel: "blocked", hardBlock: true });
    expect(await getReviewTrust(db, account)).toBe(first);

    invalidateReviewTrust(account.id);
    const after = await getReviewTrust(db, account);
    expect(after).not.toBe(first);
    expect(after.tier).toBe("watch");
  });
});

describe("shouldRunAiReview", () => {
  const trust = (sampleEvery: number): ReviewTrust => ({
    tier: sampleEvery > 1 ? "trusted" : "new",
    sampleEvery,
    reasons: [],
    stats: { deliveredCapped: 0, aiClean: 0, lastFlaggedAt: null },
    computedAt: nowIso(),
  });

  it("always reviews when sampleEvery is 1", () => {
    expect(shouldRunAiReview(trust(1), never)).toBe(true);
  });

  it("samples one in sampleEvery", () => {
    expect(shouldRunAiReview(trust(10), () => 0.05)).toBe(true);
    expect(shouldRunAiReview(trust(10), () => 0.1)).toBe(false);
    expect(shouldRunAiReview(trust(10), never)).toBe(false);
  });

  it("uses a real coin by default", () => {
    const hits = Array.from({ length: 2000 }, () => shouldRunAiReview(trust(10))).filter(Boolean);
    expect(hits.length).toBeGreaterThan(100);
    expect(hits.length).toBeLessThan(320);
  });
});

describe("reviewAndStoreContent with review trust", () => {
  let db: Db;
  beforeEach(async () => {
    db = await testDb();
    resetReviewTrustCache();
  });

  it("samples out a new shape on a trusted account without calling the AI", async () => {
    const account = await seedTrusted(db);
    const aiFn = vi.fn(async () => verdict());
    const row = await reviewAndStoreContent(db, account, CLEAN, "ai", { aiFn, random: never });
    expect(aiFn).not.toHaveBeenCalled();
    expect(row.aiReview).toBe("sampled_out");
    expect(row.trustTier).toBe("trusted");
    expect(row.rawResponseJson).toBeNull();
  });

  it("reviews the sampled shape on a trusted account", async () => {
    const account = await seedTrusted(db);
    const aiFn = vi.fn(async () => verdict());
    const row = await reviewAndStoreContent(db, account, CLEAN, "ai", { aiFn, random: always });
    expect(aiFn).toHaveBeenCalledOnce();
    expect(row.aiReview).toBe("reviewed");
  });

  it("reviews every shape on a `new` account whatever the coin says", async () => {
    const account = await seedAccount(db);
    const aiFn = vi.fn(async () => verdict());
    const row = await reviewAndStoreContent(db, account, CLEAN, "ai", { aiFn, random: never });
    expect(aiFn).toHaveBeenCalledOnce();
    expect(row.aiReview).toBe("reviewed");
    expect(row.trustTier).toBe("new");
  });

  it("records a failed AI pass as `failed` and mock mode as `off`", async () => {
    const account = await seedAccount(db);
    const aiFn = vi.fn(async (): Promise<AiRiskVerdict> => {
      throw new Error("model down");
    });
    const failed = await reviewAndStoreContent(db, account, CLEAN, "ai", { aiFn });
    expect(failed.aiReview).toBe("failed");

    const other = { ...CLEAN, subject: "Your monthly invoice is ready" };
    const off = await reviewAndStoreContent(db, account, other, undefined, { aiFn });
    expect(off.aiReview).toBe("off");
    // Outside "ai" mode trust is never computed.
    expect(off.trustTier).toBeNull();
  });

  it("re-reviews a sampled-out shape once the account drops to watch", async () => {
    const account = await seedTrusted(db);
    const aiFn = vi.fn(async () => verdict({ riskLevel: "medium" }));
    const sampled = await reviewAndStoreContent(db, account, CLEAN, "ai", { aiFn, random: never });
    expect(sampled.aiReview).toBe("sampled_out");

    // Still trusted: the cached row is returned untouched.
    const again = await reviewAndStoreContent(db, account, CLEAN, "ai", { aiFn, random: never });
    expect(again).toEqual(sampled);
    expect(aiFn).not.toHaveBeenCalled();

    // A phishing pair elsewhere on the account demotes it.
    await seedReviews(db, account.id, 1, { riskLevel: "blocked", hardBlock: true });
    invalidateReviewTrust(account.id);

    const rereviewed = await reviewAndStoreContent(db, account, CLEAN, "ai", { aiFn, random: never });
    expect(aiFn).toHaveBeenCalledOnce();
    expect(rereviewed.id).toBe(sampled.id);
    expect(rereviewed.aiReview).toBe("reviewed");
    expect(rereviewed.trustTier).toBe("watch");
    expect(rereviewed.riskLevel).toBe("medium");
    expect(rereviewed.rawResponseJson).not.toBeNull();
    expect(rereviewed.createdAt).toBe(sampled.createdAt);

    // And only once: the row is no longer sampled_out.
    await reviewAndStoreContent(db, account, CLEAN, "ai", { aiFn, random: never });
    expect(aiFn).toHaveBeenCalledOnce();
  });

  it("still blocks a phishing pair on a trusted account, and demotes it", async () => {
    const account = await seedTrusted(db);
    expect((await getReviewTrust(db, account)).tier).toBe("trusted");

    const aiFn = vi.fn(async () => verdict());
    const row = await reviewAndStoreContent(db, account, HOTDOC_PHISH, "ai", { aiFn, random: never });
    expect(aiFn).not.toHaveBeenCalled();
    expect(row.aiReview).toBe("sampled_out");
    expect(row.hardBlock).toBe(true);
    expect(isBlocking(row, account)).toBe(true);

    // The flagged verdict invalidated the cache, so the next shape is reviewed.
    expect((await getReviewTrust(db, account)).tier).toBe("watch");

    // An established account is refused, not paused.
    const after = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(after!.riskStatus).toBe("normal");
  });
});
