import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client";
import type { Account } from "../src/db/schema";
import type { SendEmailInput, SendEmailResult } from "../src/email/provider";
import { seedAccount, seedAudience, seedCampaign, seedDomain, testDb } from "./helpers";

// Drive the test-email route handler directly against a hermetic pglite DB.
// requireAccount, the rate limiter, the unsubscribe secret, and the email
// provider are the seams we replace.
let currentDb: Db;
let currentAccount: Account;

vi.mock("../src/api/context", () => ({
  requireAccount: async () => ({
    db: currentDb,
    account: currentAccount,
    auth: { userId: "user_test", orgId: "org_test", has: () => true },
  }),
}));

// Count limiter charges — the route must charge once per recipient.
let rateLimitCharges = 0;
vi.mock("../src/lib/rate-limit", () => ({
  enforceRateLimit: async () => {
    rateLimitCharges++;
  },
}));

vi.mock("../src/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/env")>()),
  requireUnsubscribeSecret: () => "x".repeat(32),
}));

// Capture sends; addresses in `failFor` report a provider failure.
let sends: SendEmailInput[] = [];
let failFor: Set<string> = new Set();
vi.mock("../src/email/factory", () => ({
  emailProviderFromEnv: () => ({
    send: async (input: SendEmailInput): Promise<SendEmailResult> => {
      sends.push(input);
      return failFor.has(input.toEmail)
        ? { provider: "mock", status: "failed", error: "mailbox unavailable" }
        : { provider: "mock", messageId: `m_${sends.length}`, status: "sent" };
    },
  }),
}));

const testEmailRoute = await import("../app/api/campaigns/[id]/test-email/route");

function call(id: string, body: unknown) {
  return testEmailRoute.POST(
    new Request(`http://localhost/api/campaigns/${id}/test-email`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as never,
    { params: Promise.resolve({ id }) } as never,
  );
}

describe("POST /api/campaigns/[id]/test-email", () => {
  let campaignId: string;

  beforeEach(async () => {
    currentDb = await testDb();
    currentAccount = await seedAccount(currentDb);
    const audience = await seedAudience(currentDb, currentAccount.id);
    const domain = await seedDomain(currentDb, currentAccount.id);
    const campaign = await seedCampaign(currentDb, {
      accountId: currentAccount.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
    });
    campaignId = campaign.id;
    sends = [];
    failFor = new Set();
    rateLimitCharges = 0;
  });

  it("sends to multiple recipients, deduped and lowercased, with [Test] subject", async () => {
    const res = await call(campaignId, {
      toEmails: ["Me@example.com", "colleague@example.com", "me@example.com"],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { ok: boolean; sent: string[]; failed: unknown[] };
    expect(data.ok).toBe(true);
    expect(data.sent).toEqual(["me@example.com", "colleague@example.com"]);
    expect(data.failed).toEqual([]);
    expect(sends.map((s) => s.toEmail)).toEqual(["me@example.com", "colleague@example.com"]);
    expect(sends[0].subject).toMatch(/^\[Test\] /);
    // One limiter charge per recipient, so N-address tests cost N singles.
    expect(rateLimitCharges).toBe(2);
  });

  it("still accepts the legacy single toEmail shape", async () => {
    const res = await call(campaignId, { toEmail: "me@example.com" });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { sent: string[] };
    expect(data.sent).toEqual(["me@example.com"]);
  });

  it("reports per-recipient failures without failing the whole request", async () => {
    failFor = new Set(["bad@example.com"]);
    const res = await call(campaignId, {
      toEmails: ["good@example.com", "bad@example.com"],
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      ok: boolean;
      sent: string[];
      failed: { email: string; error: string }[];
    };
    expect(data.ok).toBe(false);
    expect(data.sent).toEqual(["good@example.com"]);
    expect(data.failed).toEqual([{ email: "bad@example.com", error: "mailbox unavailable" }]);
  });

  it("502s when every recipient fails", async () => {
    failFor = new Set(["a@example.com", "b@example.com"]);
    const res = await call(campaignId, { toEmails: ["a@example.com", "b@example.com"] });
    expect(res.status).toBe(502);
  });

  it("rejects more than 5 recipients", async () => {
    const res = await call(campaignId, {
      toEmails: Array.from({ length: 6 }, (_, i) => `u${i}@example.com`),
    });
    expect(res.status).toBe(400);
    expect(sends).toEqual([]);
  });

  it("rejects a body with no recipients", async () => {
    const res = await call(campaignId, {});
    expect(res.status).toBe(400);
  });

  it("400s with a friendly message when the sending domain isn't verified", async () => {
    const audience = await seedAudience(currentDb, currentAccount.id);
    // Distinct domain name — the account already has the default verified one.
    const pendingDomain = await seedDomain(currentDb, currentAccount.id, {
      domain: "pending.test.co",
      verificationStatus: "pending",
    });
    const campaign = await seedCampaign(currentDb, {
      accountId: currentAccount.id,
      audienceId: audience.id,
      sendingDomainId: pendingDomain.id,
    });
    const res = await call(campaign.id, { toEmails: ["me@example.com"] });
    expect(res.status).toBe(400);
    // Pre-gate rejects before any provider send.
    expect(sends).toEqual([]);
  });

  it("400s when the campaign has no content yet", async () => {
    const audience = await seedAudience(currentDb, currentAccount.id);
    const domain = await seedDomain(currentDb, currentAccount.id, { domain: "empty.test.co" });
    const empty = await seedCampaign(currentDb, {
      accountId: currentAccount.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      htmlBody: "",
    });
    const res = await call(empty.id, { toEmails: ["me@example.com"] });
    expect(res.status).toBe(400);
    expect(sends).toEqual([]);
  });

  it("404s for a campaign owned by another account", async () => {
    const other = await seedAccount(currentDb);
    const otherAudience = await seedAudience(currentDb, other.id);
    const otherDomain = await seedDomain(currentDb, other.id);
    const foreign = await seedCampaign(currentDb, {
      accountId: other.id,
      audienceId: otherAudience.id,
      sendingDomainId: otherDomain.id,
    });
    const res = await call(foreign.id, { toEmails: ["me@example.com"] });
    expect(res.status).toBe(404);
    expect(sends).toEqual([]);
  });
});
