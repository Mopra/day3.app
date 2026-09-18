import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import {
  BOUNCE_RATE_WARNING,
  CAMPAIGN_MIN_BOUNCED_FOR_PAUSE,
  MIN_BOUNCED_FOR_PAUSE,
  MIN_FLAGGED_CAMPAIGNS_FOR_PAUSE,
  campaignMinAttempted,
  computeAccountHealth,
  enforceAccountHealth,
  enforceCampaignHealth,
} from "../src/services/health";
import { accountCampaignMetrics } from "../src/services/metrics";
import { listCampaigns } from "../src/api/lists";
import { findCampaign } from "../src/api/finders";
import {
  accounts,
  campaignRecipients,
  campaigns,
  notifications,
  type Campaign,
  type RecipientStatus,
} from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import type { Db } from "../src/db/client";
import { seedAccount, seedAudience, seedCampaign, seedDomain, testDb } from "./helpers";

// A campaign with `sent` rows already out and `bounced` rows already back,
// plus `pending` rows still to go — the shape of a send in flight.
async function fillCampaign(
  db: Db,
  campaign: Campaign,
  counts: Partial<Record<RecipientStatus, number>>,
): Promise<void> {
  const now = nowIso();
  const rows: (typeof campaignRecipients.$inferInsert)[] = [];
  for (const [status, n] of Object.entries(counts) as [RecipientStatus, number][]) {
    for (let i = 0; i < n; i++) {
      rows.push({
        id: newId("rcp"),
        campaignId: campaign.id,
        accountId: campaign.accountId,
        email: `${newId("e")}@example.com`,
        status,
        sentAt: status === "pending" ? null : now,
        bouncedAt: status === "bounced" ? now : null,
        complainedAt: status === "complained" ? now : null,
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 500) {
    await db.insert(campaignRecipients).values(rows.slice(i, i + 500));
  }
}

async function setup(status: Campaign["status"] = "sending") {
  const db = await testDb();
  const account = await seedAccount(db);
  const audience = await seedAudience(db, account.id);
  const domain = await seedDomain(db, account.id);
  const campaign = await seedCampaign(db, {
    accountId: account.id,
    audienceId: audience.id,
    sendingDomainId: domain.id,
    status,
  });
  return { db, account, audience, domain, campaign };
}

async function notes(db: Db, accountId: string, kind: string) {
  return db
    .select()
    .from(notifications)
    .where(and(eq(notifications.accountId, accountId), eq(notifications.kind, kind as never)));
}

describe("enforceCampaignHealth: one campaign, its own numbers", () => {
  it("pauses the campaign once at the warning rate and explains why", async () => {
    const { db, account, campaign } = await setup();
    // 20 of 400 = exactly 5%, with 600 still to go.
    await fillCampaign(db, campaign, { sent: 380, bounced: 20, pending: 600 });

    const health = await enforceCampaignHealth(db, campaign.id);
    expect(health?.judged).toBe(true);
    expect(health?.bounceRate).toBeCloseTo(BOUNCE_RATE_WARNING);
    expect(health?.paused).toBe(true);

    const fresh = (await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) }))!;
    expect(fresh.status).toBe("paused");
    expect(fresh.pausedCode).toBe("reputation");
    expect(fresh.pausedReason).toMatch(/20 bounced of 400 sent so far/);
    expect(fresh.reputationFlaggedAt).toBeTruthy();

    // The customer is told what happened, why it matters and what to do.
    const told = await notes(db, account.id, "campaign_reputation_paused");
    expect(told).toHaveLength(1);
    expect(told[0].title).toMatch(/too many addresses are bouncing/);
    expect(told[0].body).toMatch(/20 of the first 400 emails/);
    expect(told[0].body).toMatch(/already been removed/);
    expect(told[0].body).toMatch(/resume/);
    expect(told[0].ctaHref).toBe(`/campaigns/${campaign.id}`);

    // The account itself is nowhere near its pause line: 20 < 50 and 5% < 8%.
    const acct = (await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) }))!;
    expect(acct.riskStatus).toBe("normal");
    expect(acct.sendingEnabled).toBe(true);
  });

  it("never pauses the same campaign twice: the flag survives the user's resume", async () => {
    const { db, account, campaign } = await setup();
    await fillCampaign(db, campaign, { sent: 380, bounced: 20, pending: 600 });
    expect((await enforceCampaignHealth(db, campaign.id))?.paused).toBe(true);

    // What the resume route does.
    await db
      .update(campaigns)
      .set({ status: "sending", pausedCode: null, pausedReason: null })
      .where(eq(campaigns.id, campaign.id));
    // The rest of the list bounces at the same rate.
    await fillCampaign(db, campaign, { sent: 300, bounced: 40 });

    expect(await enforceCampaignHealth(db, campaign.id)).toBeNull();
    const fresh = (await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) }))!;
    expect(fresh.status).toBe("sending");
    expect(await notes(db, account.id, "campaign_reputation_paused")).toHaveLength(1);
  });

  it("waits until enough of the campaign is out to judge it", async () => {
    const { db, campaign } = await setup();
    // 30% bouncing, but only 100 of 1000 are out: hard bounces from the big
    // providers come back in seconds, and 100 emails do not decide a send.
    await fillCampaign(db, campaign, { sent: 70, bounced: 30, pending: 900 });
    const early = await enforceCampaignHealth(db, campaign.id);
    expect(campaignMinAttempted(1000)).toBe(200);
    expect(early?.judged).toBe(false);
    expect(early?.paused).toBe(false);

    await fillCampaign(db, campaign, { sent: 70, bounced: 30 });
    const later = await enforceCampaignHealth(db, campaign.id);
    expect(later?.judged).toBe(true);
    expect(later?.paused).toBe(true);
  });

  it("judges a small campaign after a quarter of it, not after 200", async () => {
    const { db, campaign } = await setup();
    // 100 recipients: judged from 25 attempted. 20 of 25 bouncing is a
    // purchased list, and the count floor is met.
    expect(campaignMinAttempted(100)).toBe(25);
    await fillCampaign(db, campaign, { sent: 5, bounced: CAMPAIGN_MIN_BOUNCED_FOR_PAUSE, pending: 75 });
    const health = await enforceCampaignHealth(db, campaign.id);
    expect(health?.judged).toBe(true);
    expect(health?.paused).toBe(true);
  });

  it("does nothing for a campaign that is not sending", async () => {
    const { db, campaign } = await setup("sent");
    await fillCampaign(db, campaign, { sent: 300, bounced: 100 });
    expect(await enforceCampaignHealth(db, campaign.id)).toBeNull();
  });
});

describe("enforceAccountHealth: the workspace window", () => {
  it("warns the admins once a week, and keeps sending", async () => {
    const { db, account, campaign } = await setup("sent");
    // 20 of 400 = 5%: the warning line, with the warning count met.
    await fillCampaign(db, campaign, { sent: 380, bounced: 20 });

    const first = await enforceAccountHealth(db, account.id);
    expect(first.status).toBe("warning");
    const acct = (await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) }))!;
    expect(acct.riskStatus).toBe("normal");
    expect(acct.sendingEnabled).toBe(true);

    const told = await notes(db, account.id, "account_health_warning");
    expect(told).toHaveLength(1);
    expect(told[0].body).toMatch(/20 of the 400 emails/);
    expect(told[0].body).toMatch(/You are still sending/);
    expect(told[0].body).toMatch(/Amazon SES/);

    // Every later bounce webhook re-runs this; the inbox hears it once.
    await fillCampaign(db, campaign, { bounced: 3 });
    await enforceAccountHealth(db, account.id);
    expect(await notes(db, account.id, "account_health_warning")).toHaveLength(1);
  });

  it("does not warn on a rate with too few bounces behind it", async () => {
    const { db, account, campaign } = await setup("sent");
    // 10 of 100 = 10%: over even the pause rate, but ten dead mailboxes on a
    // hundred emails is a small list ageing, not a signal.
    await fillCampaign(db, campaign, { sent: 90, bounced: 10 });
    const health = await enforceAccountHealth(db, account.id);
    expect(health.status).toBe("normal");
    expect(await notes(db, account.id, "account_health_warning")).toHaveLength(0);
  });

  it("stays quiet in the day after a campaign already paused itself for the same reason", async () => {
    const { db, account, campaign } = await setup();
    await fillCampaign(db, campaign, { sent: 380, bounced: 20, pending: 600 });
    expect((await enforceCampaignHealth(db, campaign.id))?.paused).toBe(true);

    const health = await enforceAccountHealth(db, account.id);
    expect(health.status).toBe("warning");
    expect(await notes(db, account.id, "account_health_warning")).toHaveLength(0);
  });

  it("pauses the account at the pause rate with the pause count behind it", async () => {
    const { db, account, campaign } = await setup("sent");
    // 50 of 600 = 8.3%.
    await fillCampaign(db, campaign, { sent: 550, bounced: MIN_BOUNCED_FOR_PAUSE });
    const health = await enforceAccountHealth(db, account.id);
    expect(health.status).toBe("paused");
    expect(health.reason).toMatch(/50 bounced of 600 sent/);

    const acct = (await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) }))!;
    expect(acct.riskStatus).toBe("paused");
    expect(acct.sendingEnabled).toBe(false);
    const told = await notes(db, account.id, "account_paused");
    expect(told).toHaveLength(1);
    expect(told[0].body).toMatch(/Amazon SES/);
    expect(told[0].body).toMatch(/contact support/);
  });

  it("escalates to an account pause when a second campaign flags in the window", async () => {
    const { db, account, audience, domain, campaign } = await setup("sent");
    // The window sits at the warning rate: 5%, 40 bounces. Far from 8% / 50.
    await fillCampaign(db, campaign, { sent: 760, bounced: 40 });
    const second = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "paused",
    });

    // One flagged campaign: a heads-up, still only a warning.
    await db
      .update(campaigns)
      .set({ reputationFlaggedAt: nowIso() })
      .where(eq(campaigns.id, campaign.id));
    expect((await computeAccountHealth(db, account.id)).flaggedCampaigns).toBe(1);
    expect((await enforceAccountHealth(db, account.id)).status).toBe("warning");

    // Two: the tenant keeps importing lists that bounce. That is a pattern.
    await db
      .update(campaigns)
      .set({ reputationFlaggedAt: nowIso() })
      .where(eq(campaigns.id, second.id));
    const health = await enforceAccountHealth(db, account.id);
    expect(health.flaggedCampaigns).toBe(MIN_FLAGGED_CAMPAIGNS_FOR_PAUSE);
    expect(health.status).toBe("paused");
    expect(health.reason).toMatch(/2 campaigns were paused for bouncing/);
    const acct = (await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) }))!;
    expect(acct.riskStatus).toBe("paused");
  });
});

describe("soft-deleted campaigns", () => {
  it("vanish from the tenant's reads but keep counting toward reputation", async () => {
    const { db, account, campaign } = await setup("sent");
    await fillCampaign(db, campaign, { sent: 380, bounced: 20 });
    await db
      .update(campaigns)
      .set({ deletedAt: nowIso(), reputationFlaggedAt: nowIso() })
      .where(eq(campaigns.id, campaign.id));

    expect(await listCampaigns(db, account.id)).toHaveLength(0);
    expect(await findCampaign(db, account.id, campaign.id)).toBeUndefined();
    expect(await accountCampaignMetrics(db, account.id)).toHaveLength(0);

    // Deleting the campaign did not un-happen the send.
    const health = await computeAccountHealth(db, account.id);
    expect(health.attempted).toBe(400);
    expect(health.bounced).toBe(20);
    expect(health.flaggedCampaigns).toBe(1);
    expect(health.status).toBe("warning");
  });
});
