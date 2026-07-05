import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  rescueStuckPipelineCampaigns,
  resumePausedCampaigns,
  runScheduledSweeps,
} from "../src/queue/cron";
import { accounts, campaignRecipients, campaigns, notifications } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import type { Db } from "../src/db/client";
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

const minutesAgo = (m: number) => new Date(Date.now() - m * 60 * 1000).toISOString();
const daysAhead = (d: number) => new Date(Date.now() + d * 24 * 3600 * 1000).toISOString();

// The sweep's resetMonthlyUsage stage resets accounts whose period ended (or
// was never set) — give sweep-test accounts a live period so quota assertions
// observe the stuck-lock release, not a period reset.
async function setup(accountOverrides: Record<string, unknown> = {}) {
  const db = await testDb();
  const account = await seedAccount(db, {
    currentPeriodStart: nowIso(),
    currentPeriodEnd: daysAhead(10),
    ...accountOverrides,
  });
  const domain = await seedDomain(db, account.id);
  const audience = await seedAudience(db, account.id);
  await seedSubscribers(db, account.id, audience.id, TEST_EMAILS);
  return { db, account, domain, audience };
}

async function seedRecipients(
  db: Db,
  accountId: string,
  campaignId: string,
  rows: { status: string; lockedAt?: string | null }[],
) {
  await db.insert(campaignRecipients).values(
    rows.map((r, i) => ({
      id: newId("rcp"),
      campaignId,
      accountId,
      email: `r${i}@example.com`,
      status: r.status as "pending",
      lockedAt: r.lockedAt ?? null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    })),
  );
}

describe("stuck-lock sweep", () => {
  it("fails stale sending rows (never back to pending), spares fresh locks, and releases their quota", async () => {
    const { db, account, domain, audience } = await setup({ monthlyEmailSentCount: 5 });
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "sending",
    });
    await seedRecipients(db, account.id, campaign.id, [
      { status: "sending", lockedAt: minutesAgo(20) }, // crashed batch
      { status: "sending", lockedAt: minutesAgo(20) }, // crashed batch
      { status: "sending", lockedAt: minutesAgo(1) }, // live batch — must be spared
      { status: "pending" },
    ]);

    const queue = new FakeQueue();
    await runScheduledSweeps({ db, queue: asQueue(queue) });

    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    const failed = rows.filter((r) => r.status === "failed");
    // The duplicate firewall: crashed rows go to failed — the email may have
    // left — and are NEVER returned to pending, where they would be re-sent.
    expect(failed).toHaveLength(2);
    expect(failed.every((r) => r.error?.includes("stuck lock"))).toBe(true);
    expect(rows.filter((r) => r.status === "sending")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(1);

    // The crashed batch never ran its flush, so the sweep releases the two
    // failed rows' quota reservation.
    const fresh = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(fresh?.monthlyEmailSentCount).toBe(3);

    // One row is still in flight (fresh lock) → the reconcile stage must NOT
    // nudge extra lanes into a campaign that's still being drained.
    expect(queue.messages.filter((m) => m.type === "send_campaign_batch")).toHaveLength(0);
  });

  it("re-fans-out a fully stalled campaign at proper lane width", async () => {
    const { db, account, domain, audience } = await setup();
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "sending",
    });
    // 250 pending, nothing in flight → stalled (lanes died); expect
    // ceil(250 / SEND_BATCH_SIZE=100) = 3 lanes, not a single limping one.
    await seedRecipients(
      db,
      account.id,
      campaign.id,
      Array.from({ length: 250 }, () => ({ status: "pending" })),
    );

    const queue = new FakeQueue();
    await runScheduledSweeps({ db, queue: asQueue(queue) });

    const nudges = queue.messages.filter((m) => m.type === "send_campaign_batch");
    expect(nudges).toHaveLength(3);
  });

  it("completes a drained campaign exactly once and discloses failures in the notification", async () => {
    const { db, account, domain, audience } = await setup();
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "sending",
    });
    await seedRecipients(db, account.id, campaign.id, [
      { status: "sent" },
      { status: "sent" },
      { status: "sent" },
      { status: "failed" },
    ]);

    const queue = new FakeQueue();
    await runScheduledSweeps({ db, queue: asQueue(queue) });
    await runScheduledSweeps({ db, queue: asQueue(queue) }); // idempotent

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sent");
    expect(fresh?.sentAt).toBeTruthy();

    const sentNotifications = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.accountId, account.id), eq(notifications.kind, "campaign_sent")),
      );
    expect(sentNotifications).toHaveLength(1);
    // Honest completion: the failed recipient is disclosed, not silently omitted.
    expect(sentNotifications[0].body).toContain("couldn't be sent");
  });
});

describe("auto-resume of paused campaigns", () => {
  it("resumes a rate-limit pause after the cool-down but never a user pause", async () => {
    const { db, account, domain, audience } = await setup();
    const rateLimited = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "paused",
    });
    const userPaused = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "paused",
    });
    await db
      .update(campaigns)
      .set({ pausedCode: "rate_limit", updatedAt: minutesAgo(20) })
      .where(eq(campaigns.id, rateLimited.id));
    await db
      .update(campaigns)
      .set({ pausedCode: "user", updatedAt: minutesAgo(20) })
      .where(eq(campaigns.id, userPaused.id));
    await seedRecipients(db, account.id, rateLimited.id, [
      { status: "pending" },
      { status: "pending" },
    ]);

    const queue = new FakeQueue();
    const resumed = await resumePausedCampaigns(db, asQueue(queue), new Date());

    expect(resumed).toBe(1);
    const freshRate = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, rateLimited.id),
    });
    expect(freshRate?.status).toBe("sending");
    expect(freshRate?.pausedCode).toBeNull();
    expect(queue.messages.filter((m) => m.type === "send_campaign_batch").length).toBeGreaterThan(
      0,
    );
    const freshUser = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, userPaused.id),
    });
    expect(freshUser?.status).toBe("paused");
  });

  it("does not resume a rate-limit pause before its cool-down", async () => {
    const { db, account, domain, audience } = await setup();
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "paused",
    });
    await db
      .update(campaigns)
      .set({ pausedCode: "rate_limit", updatedAt: minutesAgo(2) })
      .where(eq(campaigns.id, campaign.id));

    const queue = new FakeQueue();
    const resumed = await resumePausedCampaigns(db, asQueue(queue), new Date());
    expect(resumed).toBe(0);
  });

  it("resumes a quota pause only once the account has headroom again", async () => {
    const { db, account, domain, audience } = await setup({
      monthlyEmailLimit: 10,
      monthlyEmailSentCount: 10,
    });
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "paused",
    });
    await db
      .update(campaigns)
      .set({ pausedCode: "quota", updatedAt: minutesAgo(60) })
      .where(eq(campaigns.id, campaign.id));
    await seedRecipients(db, account.id, campaign.id, [{ status: "pending" }]);

    const queue = new FakeQueue();
    expect(await resumePausedCampaigns(db, asQueue(queue), new Date())).toBe(0);
    expect(
      (await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) }))?.status,
    ).toBe("paused");

    // Quota frees up (monthly reset / upgrade) → next sweep resumes it.
    await db
      .update(accounts)
      .set({ monthlyEmailSentCount: 0 })
      .where(eq(accounts.id, account.id));
    expect(await resumePausedCampaigns(db, asQueue(queue), new Date())).toBe(1);
    expect(
      (await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) }))?.status,
    ).toBe("sending");
  });
});

describe("stuck pipeline rescue", () => {
  it("re-enqueues the driving job for campaigns stranded in intermediate states", async () => {
    const { db, account, domain, audience } = await setup();
    const stuckApproved = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "approved",
    });
    const stuckReview = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "pending_review",
    });
    const freshApproved = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "approved",
    });
    await db
      .update(campaigns)
      .set({ updatedAt: minutesAgo(45) })
      .where(eq(campaigns.id, stuckApproved.id));
    await db
      .update(campaigns)
      .set({ updatedAt: minutesAgo(45) })
      .where(eq(campaigns.id, stuckReview.id));

    const queue = new FakeQueue();
    const rescued = await rescueStuckPipelineCampaigns(db, asQueue(queue), new Date());

    expect(rescued).toBe(2);
    const types = queue.messages.map((m) => m.type).sort();
    expect(types).toEqual(["generate_campaign_recipients", "review_campaign"]);
    expect(
      queue.messages.find((m) => m.type === "generate_campaign_recipients"),
    ).toMatchObject({ campaignId: stuckApproved.id });
    expect(queue.messages.find((m) => m.type === "review_campaign")).toMatchObject({
      campaignId: stuckReview.id,
    });
    // The fresh campaign (its job is presumably still queued/running) is left alone.
    expect(queue.messages.some((m) => "campaignId" in m && m.campaignId === freshApproved.id)).toBe(
      false,
    );

    // Rescue resets the staleness clock — an immediate second sweep must not
    // double-enqueue while the rescue job waits its turn.
    const queue2 = new FakeQueue();
    expect(await rescueStuckPipelineCampaigns(db, asQueue(queue2), new Date())).toBe(0);
  });
});

describe("monthly usage reset via sweep", () => {
  it("resets an elapsed period on any sweep run, not just the day-1 03:00 window", async () => {
    const db = await testDb();
    const account = await seedAccount(db, {
      monthlyEmailSentCount: 500,
      currentPeriodStart: minutesAgo(60 * 24 * 40),
      currentPeriodEnd: minutesAgo(60 * 24 * 5), // period ended 5 days ago
    });

    // Any ordinary sweep tick — the old calendar gate (UTC day 1, 03:00–03:15)
    // would have left this account blocked for up to a month.
    await runScheduledSweeps({ db, queue: asQueue(new FakeQueue()) });

    const fresh = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(fresh?.monthlyEmailSentCount).toBe(0);
    expect(Date.parse(fresh!.currentPeriodEnd!)).toBeGreaterThan(Date.now());
  });
});
