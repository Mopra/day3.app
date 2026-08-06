import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { generateCampaignRecipients } from "../src/queue/handlers/generate-recipients";
import { sendCampaignBatch } from "../src/queue/handlers/send-batch";
import { accounts, campaignRecipients, campaigns } from "../src/db/schema";
import { campaignSendGateError, sandboxRecipientCount } from "../src/api/campaigns";
import { SANDBOX_MONTHLY_ALLOWANCE } from "../src/lib/plans-catalog";
import {
  FakeQueue,
  RecordingProvider,
  asQueue,
  seedAccount,
  seedAudience,
  seedCampaign,
  seedDomain,
  seedMember,
  seedSubscribers,
  testDb,
} from "./helpers";

// Sandbox mode: a free (set-up-only) org runs the real send pipeline, but only
// to its own org members and only against the shared monthly allowance. These
// tests cover the three places that has to hold — the accept-time gate, the
// recipient set, and the quota reservation — plus the ways it must NOT leak.

const TEAM = "founder@test.co";
const OUTSIDER = "stranger@example.com";

// A free-tier org (plan limit 0, sendingEnabled false — the real free-tier row
// shape) with one org member and an audience holding that member plus a
// stranger, so every test can check who actually gets mail.
async function setupSandboxOrg(opts: { sentCount?: number } = {}) {
  const db = await testDb();
  const account = await seedAccount(db, {
    plan: "free_org",
    monthlyEmailLimit: 0,
    monthlyEmailSentCount: opts.sentCount ?? 0,
    sendingEnabled: false,
  });
  await seedMember(db, account.id, TEAM);
  const domain = await seedDomain(db, account.id);
  const audience = await seedAudience(db, account.id);
  await seedSubscribers(db, account.id, audience.id, [TEAM, OUTSIDER]);
  return { db, account, domain, audience };
}

function deps(db: Awaited<ReturnType<typeof testDb>>, queue: FakeQueue, provider: RecordingProvider) {
  return {
    db,
    jobsQueue: asQueue(queue),
    emailProvider: provider,
    appUrl: "http://localhost:5173",
    unsubscribeSecret: "test-secret",
  };
}

describe("sandbox send gate", () => {
  it("passes when a teammate is in the audience", async () => {
    const { db, account, domain, audience } = await setupSandboxOrg();
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
    });
    expect(await campaignSendGateError(db, account.id, campaign, { sandbox: true })).toBeNull();
  });

  it("blocks with an actionable message when the audience holds no teammates", async () => {
    const { db, account, domain } = await setupSandboxOrg();
    const strangersOnly = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, strangersOnly.id, [OUTSIDER]);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: strangersOnly.id,
      sendingDomainId: domain.id,
    });

    const error = await campaignSendGateError(db, account.id, campaign, { sandbox: true });
    expect(error).toMatch(/your own team/i);
    // The same audience is perfectly sendable on a paid plan — the restriction
    // must come from the mode, not from the audience.
    expect(await campaignSendGateError(db, account.id, campaign, { sandbox: false })).toBeNull();
  });

  it("counts only teammates as the sandbox send's real reach", async () => {
    const { db, account, audience } = await setupSandboxOrg();
    expect(await sandboxRecipientCount(db, account.id, { audienceId: audience.id })).toBe(1);
  });
});

describe("sandbox recipient generation", () => {
  it("generates recipients for org members only", async () => {
    const { db, account, domain, audience } = await setupSandboxOrg();
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "approved",
      sandbox: true,
    });
    const queue = new FakeQueue();

    await generateCampaignRecipients(
      { campaignId: campaign.id, accountId: account.id },
      db,
      asQueue(queue),
    );

    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(rows.map((r) => r.email)).toEqual([TEAM]);

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sending");
  });

  it("keeps the whole audience for a non-sandbox campaign on the same data", async () => {
    const { db, account, domain, audience } = await setupSandboxOrg();
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "approved",
      sandbox: false,
    });

    await generateCampaignRecipients(
      { campaignId: campaign.id, accountId: account.id },
      db,
      asQueue(new FakeQueue()),
    );

    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(rows.map((r) => r.email).sort()).toEqual([TEAM, OUTSIDER].sort());
  });

  it("pauses instead of completing an empty send when no teammate remains", async () => {
    const { db, account, domain } = await setupSandboxOrg();
    const strangersOnly = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, strangersOnly.id, [OUTSIDER]);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: strangersOnly.id,
      sendingDomainId: domain.id,
      status: "approved",
      sandbox: true,
    });
    const queue = new FakeQueue();

    await generateCampaignRecipients(
      { campaignId: campaign.id, accountId: account.id },
      db,
      asQueue(queue),
    );

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    // Not "sent" — a zero-recipient success is indistinguishable from a real one.
    expect(fresh?.status).toBe("paused");
    expect(fresh?.pausedCode).toBe("user");
    expect(queue.messages).toHaveLength(0);
  });
});

describe("sandbox send batch", () => {
  it("sends despite a zero plan limit and meters the shared counter", async () => {
    const { db, account, domain, audience } = await setupSandboxOrg();
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "approved",
      sandbox: true,
    });
    const queue = new FakeQueue();
    await generateCampaignRecipients(
      { campaignId: campaign.id, accountId: account.id },
      db,
      asQueue(queue),
    );

    const provider = new RecordingProvider();
    await sendCampaignBatch(
      { campaignId: campaign.id, accountId: account.id, batchSize: 25 },
      deps(db, new FakeQueue(), provider),
    );

    expect(provider.sent.map((s) => s.toEmail)).toEqual([TEAM]);
    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sent");
    // Metered on the same ledger as a paid send — one email, one unit.
    const acct = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(acct?.monthlyEmailSentCount).toBe(1);
  });

  it("pauses on quota once the sandbox allowance is gone", async () => {
    const { db, account, domain, audience } = await setupSandboxOrg({
      sentCount: SANDBOX_MONTHLY_ALLOWANCE,
    });
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "approved",
      sandbox: true,
    });
    await generateCampaignRecipients(
      { campaignId: campaign.id, accountId: account.id },
      db,
      asQueue(new FakeQueue()),
    );

    const provider = new RecordingProvider();
    await sendCampaignBatch(
      { campaignId: campaign.id, accountId: account.id, batchSize: 25 },
      deps(db, new FakeQueue(), provider),
    );

    expect(provider.sent).toHaveLength(0);
    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("paused");
    expect(fresh?.pausedCode).toBe("quota");
    expect(fresh?.pausedReason).toMatch(/sandbox/i);
  });

  it("still refuses to send a sandbox campaign on a risk-paused account", async () => {
    const { db, account, domain, audience } = await setupSandboxOrg();
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "approved",
      sandbox: true,
    });
    await generateCampaignRecipients(
      { campaignId: campaign.id, accountId: account.id },
      db,
      asQueue(new FakeQueue()),
    );
    await db
      .update(accounts)
      .set({ riskStatus: "paused", pausedReason: "High bounce rate" })
      .where(eq(accounts.id, account.id));

    const provider = new RecordingProvider();
    await sendCampaignBatch(
      { campaignId: campaign.id, accountId: account.id, batchSize: 25 },
      deps(db, new FakeQueue(), provider),
    );

    expect(provider.sent).toHaveLength(0);
    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("paused");
    expect(fresh?.pausedCode).toBe("account");
  });

  it("does not meter a paid send against the sandbox allowance", async () => {
    // Regression guard for the override: a paid account with a limit above the
    // sandbox allowance must be able to send past it.
    const db = await testDb();
    const account = await seedAccount(db, {
      monthlyEmailLimit: 10_000,
      monthlyEmailSentCount: SANDBOX_MONTHLY_ALLOWANCE,
    });
    const domain = await seedDomain(db, account.id);
    const audience = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, audience.id, [OUTSIDER]);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "approved",
    });
    await generateCampaignRecipients(
      { campaignId: campaign.id, accountId: account.id },
      db,
      asQueue(new FakeQueue()),
    );

    const provider = new RecordingProvider();
    await sendCampaignBatch(
      { campaignId: campaign.id, accountId: account.id, batchSize: 25 },
      deps(db, new FakeQueue(), provider),
    );

    expect(provider.sent).toHaveLength(1);
  });
});
