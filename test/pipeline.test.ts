import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { reviewCampaign } from "../src/worker/queue/handlers/review-campaign";
import { generateCampaignRecipients } from "../src/worker/queue/handlers/generate-recipients";
import { campaignRecipients, campaigns, riskReviews } from "../src/worker/db/schema";
import { addSuppression } from "../src/worker/services/suppression";
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

async function setup(htmlBody?: string, subject?: string) {
  const db = testDb();
  const account = await seedAccount(db);
  const domain = await seedDomain(db, account.id);
  const audience = await seedAudience(db, account.id);
  await seedSubscribers(db, account.id, audience.id, TEST_EMAILS);
  const campaign = await seedCampaign(db, {
    accountId: account.id,
    audienceId: audience.id,
    sendingDomainId: domain.id,
    status: "pending_review",
    htmlBody,
    subject,
  });
  return { db, account, audience, campaign };
}

describe("review_campaign", () => {
  it("approves a low-risk product update and enqueues recipient generation", async () => {
    const { db, account, campaign } = await setup();
    const queue = new FakeQueue();

    await reviewCampaign(
      { campaignId: campaign.id, accountId: account.id },
      db,
      asQueue(queue),
      "mock",
    );

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("approved");
    expect(fresh?.riskLevel).toBe("low");
    expect(queue.messages[0]?.type).toBe("generate_campaign_recipients");

    const review = await db.query.riskReviews.findFirst({
      where: eq(riskReviews.campaignId, campaign.id),
    });
    expect(review).toBeTruthy();
  });

  it("blocks prohibited content", async () => {
    const { db, account, campaign } = await setup(
      "<p>Join our casino and win big with bitcoin!</p>",
    );
    const queue = new FakeQueue();

    await reviewCampaign(
      { campaignId: campaign.id, accountId: account.id },
      db,
      asQueue(queue),
      "mock",
    );

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("blocked");
    expect(fresh?.riskLevel).toBe("blocked");
    expect(queue.messages).toHaveLength(0);
  });

  it("is a no-op when the campaign is not pending review (idempotent)", async () => {
    const { db, account, campaign } = await setup();
    const queue = new FakeQueue();
    await db
      .update(campaigns)
      .set({ status: "sent" })
      .where(eq(campaigns.id, campaign.id));

    await reviewCampaign(
      { campaignId: campaign.id, accountId: account.id },
      db,
      asQueue(queue),
      "mock",
    );

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sent");
    expect(queue.messages).toHaveLength(0);
  });
});

describe("generate_campaign_recipients", () => {
  it("creates pending recipients for subscribed members, excluding suppressed", async () => {
    const { db, account, audience, campaign } = await setup();
    await db.update(campaigns).set({ status: "approved" }).where(eq(campaigns.id, campaign.id));
    await addSuppression(db, {
      accountId: account.id,
      email: "dana@example.com",
      reason: "complaint",
    });
    // One unsubscribed member must be excluded too.
    const { subscribers: subsTable } = await import("../src/worker/db/schema");
    await db
      .update(subsTable)
      .set({ status: "unsubscribed" })
      .where(eq(subsTable.email, "erik@example.com"));

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
    expect(rows.map((r) => r.email).sort()).toEqual([
      "alice@example.com",
      "bob@example.com",
      "charlie@example.com",
    ]);
    expect(rows.every((r) => r.status === "pending")).toBe(true);

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sending");
    expect(queue.messages[0]?.type).toBe("send_campaign_batch");

    void audience;
  });

  it("does not duplicate recipients when retried", async () => {
    const { db, account, campaign } = await setup();
    await db.update(campaigns).set({ status: "approved" }).where(eq(campaigns.id, campaign.id));

    const queue = new FakeQueue();
    const message = { campaignId: campaign.id, accountId: account.id };
    await generateCampaignRecipients(message, db, asQueue(queue));

    // Simulate a retry mid-pipeline: reset status as if the first attempt
    // crashed after inserting rows.
    await db
      .update(campaigns)
      .set({ status: "generating_recipients" })
      .where(eq(campaigns.id, campaign.id));
    await generateCampaignRecipients(message, db, asQueue(queue));

    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(rows).toHaveLength(5);
  });
});
