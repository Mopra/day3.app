// New accounts are held on less than `high`: an AI lure concern, or a flagged
// review mailing a mostly-consumer list. Service spt (2026-10-19) sent 496
// emails on day one through a review that said "reads like a lure".
import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { campaigns } from "../src/db/schema";
import type { CampaignRiskReview } from "../src/services/risk";
import { aiNamesLure, isConsumerHeavy, newAccountHoldReason } from "../src/services/new-account-hold";
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

const aiOverride = vi.hoisted(() => ({ review: null as CampaignRiskReview | null }));
vi.mock("../src/services/risk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/services/risk")>();
  return {
    ...actual,
    reviewCampaignRisk: async (...args: Parameters<typeof actual.reviewCampaignRisk>) =>
      aiOverride.review ?? actual.reviewCampaignRisk(...args),
  };
});

const { reviewCampaign } = await import("../src/queue/handlers/review-campaign");

function lureReview(riskLevel: CampaignRiskReview["riskLevel"] = "medium"): CampaignRiskReview {
  return {
    riskLevel,
    riskScore: 40,
    categories: [],
    summary: "AI review: This reads like a lure that could be used to impersonate another service.",
    guidance: [],
    recommendedAction: riskLevel === "low" ? "approve" : "manual_review",
    ai: {
      riskLevel,
      categories: [],
      rationale: "This reads like a lure that could be used to impersonate another service.",
      guidance: [],
      model: "test",
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  };
}

const consumerEmails = Array.from({ length: 30 }, (_, i) =>
  i % 2 === 0 ? `person${i}@gmail.com` : `person${i}@icloud.com`,
);

async function setup(opts: { newAccount: boolean; emails: string[]; htmlBody?: string }) {
  const db = await testDb();
  const account = await seedAccount(db, opts.newAccount ? { rampLiftedAt: null } : {});
  const domain = await seedDomain(db, account.id);
  const audience = await seedAudience(db, account.id);
  await seedSubscribers(db, account.id, audience.id, opts.emails);
  const campaign = await seedCampaign(db, {
    accountId: account.id,
    audienceId: audience.id,
    sendingDomainId: domain.id,
    status: "pending_review",
    htmlBody: opts.htmlBody,
  });
  const queue = new FakeQueue();
  await reviewCampaign({ campaignId: campaign.id, accountId: account.id }, db, asQueue(queue), "mock");
  const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
  return { fresh, queue };
}

const MEDIUM = '<p>Act now! Last chance! <a href="https://bit.ly/x">Click</a></p>';

describe("new-account campaign holds", () => {
  beforeEach(() => {
    aiOverride.review = null;
  });

  it("holds a new account's campaign when the AI names a lure", async () => {
    aiOverride.review = lureReview("medium");
    const { fresh, queue } = await setup({ newAccount: true, emails: TEST_EMAILS });
    expect(fresh?.status).toBe("paused");
    expect(fresh?.pausedCode).toBe("review");
    expect(fresh?.pausedReason).toContain("lure");
    expect(queue.messages).toHaveLength(0);
  });

  it("holds an AI lure category even when the level is low", async () => {
    const low = lureReview("low");
    aiOverride.review = { ...low, ai: { ...low.ai!, categories: ["brand_impersonation"] } };
    const { fresh } = await setup({ newAccount: true, emails: TEST_EMAILS });
    expect(fresh?.pausedCode).toBe("review");
  });

  it("never holds a sandbox campaign, which only reaches the org's members", async () => {
    aiOverride.review = lureReview("medium");
    const db = await testDb();
    const account = await seedAccount(db, { rampLiftedAt: null });
    const domain = await seedDomain(db, account.id);
    const audience = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, audience.id, TEST_EMAILS);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "pending_review",
    });
    await db.update(campaigns).set({ sandbox: true }).where(eq(campaigns.id, campaign.id));
    await reviewCampaign({ campaignId: campaign.id, accountId: account.id }, db, asQueue(new FakeQueue()), "mock");
    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("approved");
  });

  it("lets an established account's lure concern send, flagged", async () => {
    aiOverride.review = lureReview("medium");
    const { fresh, queue } = await setup({ newAccount: false, emails: TEST_EMAILS });
    expect(fresh?.status).toBe("approved");
    expect(queue.messages[0]?.type).toBe("generate_campaign_recipients");
  });

  it("holds a new account's medium campaign to a mostly consumer list", async () => {
    const { fresh, queue } = await setup({ newAccount: true, emails: consumerEmails, htmlBody: MEDIUM });
    expect(fresh?.riskLevel).toBe("medium");
    expect(fresh?.pausedCode).toBe("review");
    expect(fresh?.pausedReason).toContain("100% of the 30 contacts");
    expect(queue.messages).toHaveLength(0);
  });

  it("sends a new account's clean campaign to a consumer list", async () => {
    // B2C products exist: a consumer list alone is not evidence.
    const { fresh } = await setup({ newAccount: true, emails: consumerEmails });
    expect(fresh?.riskLevel).toBe("low");
    expect(fresh?.status).toBe("approved");
  });

  it("sends a new account's medium campaign to a work-address list", async () => {
    const work = Array.from({ length: 30 }, (_, i) => `person${i}@acme.io`);
    const { fresh } = await setup({ newAccount: true, emails: work, htmlBody: MEDIUM });
    expect(fresh?.riskLevel).toBe("medium");
    expect(fresh?.status).toBe("approved");
  });
});

describe("new-account hold rules", () => {
  it("reads a lure from categories or rationale", () => {
    const base = lureReview();
    expect(aiNamesLure(base)).toBe(true);
    expect(aiNamesLure({ ai: { ...base.ai!, rationale: "Fine.", categories: ["brand_impersonation"] } })).toBe(true);
    expect(aiNamesLure({ ai: { ...base.ai!, rationale: "Somewhat salesy.", categories: ["aggressive_sales"] } })).toBe(false);
    expect(aiNamesLure({ ai: null })).toBe(false);
    // A rationale saying what it did NOT find is not a lure.
    expect(
      aiNamesLure({ ai: { ...base.ai!, rationale: "No phishing or impersonation indicators. Mildly promotional." } }),
    ).toBe(false);
    // Words alone count only when the AI rated it above low.
    expect(aiNamesLure({ ai: { ...base.ai!, riskLevel: "low" } })).toBe(false);
  });

  it("needs enough recipients before the share counts", () => {
    expect(isConsumerHeavy({ total: 5, consumer: 5 })).toBe(false);
    expect(isConsumerHeavy({ total: 30, consumer: 24 })).toBe(true);
    expect(isConsumerHeavy({ total: 30, consumer: 20 })).toBe(false);
    expect(newAccountHoldReason({ ai: null, riskLevel: "low" }, { total: 30, consumer: 30 })).toBeNull();
  });
});
