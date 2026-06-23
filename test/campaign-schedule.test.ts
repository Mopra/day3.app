import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { campaigns } from "../src/db/schema";
import { nowIso } from "../src/lib/ids";
import { releaseDueCampaigns } from "../src/queue/cron";
import {
  FakeQueue,
  seedAccount,
  seedAudience,
  seedCampaign,
  seedDomain,
  seedSubscribers,
  testDb,
} from "./helpers";

// Parks a campaign in "scheduled" with the given send time (relative to now).
async function schedule(db: Awaited<ReturnType<typeof testDb>>, id: string, at: Date) {
  await db
    .update(campaigns)
    .set({ status: "scheduled", scheduledAt: at.toISOString(), updatedAt: nowIso() })
    .where(eq(campaigns.id, id));
}

describe("releaseDueCampaigns", () => {
  it("hands a due, sendable campaign to the review pipeline", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const domain = await seedDomain(db, account.id); // verified by default
    const audience = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, audience.id, ["a@example.com"]);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
    });
    await schedule(db, campaign.id, new Date(Date.now() - 60_000)); // a minute ago

    const queue = new FakeQueue();
    const released = await releaseDueCampaigns(db, queue, new Date());

    expect(released).toBe(1);
    const after = await db.query.campaigns.findFirst({
      where: (t, { eq }) => eq(t.id, campaign.id),
    });
    expect(after?.status).toBe("pending_review");
    expect(after?.scheduledAt).toBeNull();
    expect(queue.messages).toEqual([
      { type: "review_campaign", campaignId: campaign.id, accountId: account.id },
    ]);
  });

  it("leaves a campaign scheduled in the future untouched", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const domain = await seedDomain(db, account.id);
    const audience = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, audience.id, ["a@example.com"]);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
    });
    await schedule(db, campaign.id, new Date(Date.now() + 60 * 60 * 1000)); // an hour out

    const queue = new FakeQueue();
    const released = await releaseDueCampaigns(db, queue, new Date());

    expect(released).toBe(0);
    const after = await db.query.campaigns.findFirst({
      where: (t, { eq }) => eq(t.id, campaign.id),
    });
    expect(after?.status).toBe("scheduled");
    expect(queue.messages).toHaveLength(0);
  });

  it("returns a due campaign to draft (with a reason) when a gate now fails", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    // Domain never verified → the send gate fails at release time.
    const domain = await seedDomain(db, account.id, { verificationStatus: "pending" });
    const audience = await seedAudience(db, account.id);
    await seedSubscribers(db, account.id, audience.id, ["a@example.com"]);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
    });
    await schedule(db, campaign.id, new Date(Date.now() - 60_000));

    const queue = new FakeQueue();
    const released = await releaseDueCampaigns(db, queue, new Date());

    expect(released).toBe(0);
    const after = await db.query.campaigns.findFirst({
      where: (t, { eq }) => eq(t.id, campaign.id),
    });
    expect(after?.status).toBe("draft");
    expect(after?.scheduledAt).toBeNull();
    expect(after?.pausedReason).toContain("verified");
    expect(queue.messages).toHaveLength(0);
  });
});
