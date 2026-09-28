// A young account's campaign that runs into the new-account ramp
// (services/send-ramp.ts). It used to pause with "Monthly email limit was
// reached… upgrade your plan" — wrong for an account with plenty of plan left —
// and the cron then resumed it into the same wall every sweep until midnight UTC.
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resumePausedCampaigns } from "../src/queue/cron";
import { generateCampaignRecipients } from "../src/queue/handlers/generate-recipients";
import { sendCampaignBatch } from "../src/queue/handlers/send-batch";
import { campaigns } from "../src/db/schema";
import { nowIso } from "../src/lib/ids";
import { utcDayKey } from "../src/services/send-ramp";
import {
  FakeQueue,
  RecordingProvider,
  TEST_EMAILS,
  asQueue,
  seedAccount,
  seedAudience,
  seedCampaign,
  seedDomain,
  seedSubscribers,
  testDb,
} from "./helpers";

const daysAhead = (d: number) => new Date(Date.now() + d * 86_400_000).toISOString();

// A day-0 paid account whose ramp for today is already spent.
async function setup() {
  const db = await testDb();
  const account = await seedAccount(db, {
    createdAt: nowIso(),
    rampLiftedAt: null,
    monthlyEmailLimit: 100_000,
    currentPeriodStart: nowIso(),
    currentPeriodEnd: daysAhead(10),
    dailySentCount: 500,
    dailySentDate: utcDayKey(),
  });
  const domain = await seedDomain(db, account.id);
  const audience = await seedAudience(db, account.id);
  await seedSubscribers(db, account.id, audience.id, TEST_EMAILS);
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
  return { db, account, campaign };
}

describe("campaign paused by the new-account ramp", () => {
  it("says it is the ramp, not the plan", async () => {
    const { db, account, campaign } = await setup();
    const provider = new RecordingProvider();
    await sendCampaignBatch(
      { campaignId: campaign.id, accountId: account.id, batchSize: 25 },
      {
        db,
        jobsQueue: asQueue(new FakeQueue()),
        emailProvider: provider,
        appUrl: "http://localhost:5173",
        unsubscribeSecret: "test-secret",
      },
    );

    expect(provider.sent).toHaveLength(0);
    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("paused");
    expect(fresh?.pausedCode).toBe("quota");
    expect(fresh?.pausedReason).toMatch(/00:00 UTC/);
    expect(fresh?.pausedReason).not.toMatch(/upgrade/i);
  });

  it("is not resumed while today's ramp is spent, and is resumed the next day", async () => {
    const { db, campaign } = await setup();
    await db
      .update(campaigns)
      .set({ status: "paused", pausedCode: "quota", updatedAt: new Date(Date.now() - 3_600_000).toISOString() })
      .where(eq(campaigns.id, campaign.id));

    const queue = new FakeQueue();
    expect(await resumePausedCampaigns(db, asQueue(queue), new Date())).toBe(0);

    const tomorrow = new Date(Date.now() + 86_400_000);
    expect(await resumePausedCampaigns(db, asQueue(queue), tomorrow)).toBe(1);
    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sending");
  });
});
