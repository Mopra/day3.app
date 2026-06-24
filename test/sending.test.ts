import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { sendCampaignBatch } from "../src/queue/handlers/send-batch";
import { generateCampaignRecipients } from "../src/queue/handlers/generate-recipients";
import { campaignRecipients, campaigns, accounts, subscribers } from "../src/db/schema";
import { addSuppression } from "../src/services/suppression";
import { campaignPersonalizationGaps } from "../src/api/campaigns";
import { newId, nowIso } from "../src/lib/ids";
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

async function setupSendingCampaign(opts: { limit?: number; sentCount?: number } = {}) {
  const db = await testDb();
  const account = await seedAccount(db, {
    monthlyEmailLimit: opts.limit ?? 10_000,
    monthlyEmailSentCount: opts.sentCount ?? 0,
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

  const queue = new FakeQueue();
  await generateCampaignRecipients(
    { campaignId: campaign.id, accountId: account.id },
    db,
    asQueue(queue),
  );
  return { db, account, campaign, queue };
}

function deps(db: ReturnType<typeof testDb>, queue: FakeQueue, provider: RecordingProvider) {
  return {
    db,
    jobsQueue: asQueue(queue),
    emailProvider: provider,
    appUrl: "http://localhost:5173",
    unsubscribeSecret: "test-secret",
  };
}

describe("send_campaign_batch", () => {
  it("sends pending recipients, marks them sent, and completes the campaign", async () => {
    const { db, account, campaign } = await setupSendingCampaign();
    const queue = new FakeQueue();
    const provider = new RecordingProvider();

    await sendCampaignBatch(
      { campaignId: campaign.id, accountId: account.id, batchSize: 25 },
      deps(db, queue, provider),
    );

    expect(provider.sent).toHaveLength(5);
    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    expect(rows.every((r) => r.providerMessageId)).toBeTruthy();

    const fresh = await db.query.campaigns.findFirst({
      where: eq(campaigns.id, campaign.id),
    });
    expect(fresh?.status).toBe("sent");
    expect(fresh?.sentAt).toBeTruthy();

    const freshAccount = await db.query.accounts.findFirst({
      where: eq(accounts.id, account.id),
    });
    expect(freshAccount?.monthlyEmailSentCount).toBe(5);
  });

  it("does not duplicate sends when the same message is retried", async () => {
    const { db, account, campaign } = await setupSendingCampaign();
    const queue = new FakeQueue();
    const provider = new RecordingProvider();
    const message = { campaignId: campaign.id, accountId: account.id, batchSize: 25 };

    await sendCampaignBatch(message, deps(db, queue, provider));
    expect(provider.sent).toHaveLength(5);

    // Same queue message delivered again (Queues are at-least-once).
    await sendCampaignBatch(message, deps(db, queue, provider));
    expect(provider.sent).toHaveLength(5);

    const freshAccount = await db.query.accounts.findFirst({
      where: eq(accounts.id, account.id),
    });
    expect(freshAccount?.monthlyEmailSentCount).toBe(5);
  });

  it("does not resend recipients claimed by a crashed batch", async () => {
    const { db, account, campaign } = await setupSendingCampaign();
    const queue = new FakeQueue();
    const provider = new RecordingProvider();
    provider.throwOnCall = 2; // crash mid-batch after 2 successful sends
    const message = { campaignId: campaign.id, accountId: account.id, batchSize: 25 };

    await expect(sendCampaignBatch(message, deps(db, queue, provider))).rejects.toThrow(
      "provider exploded",
    );
    expect(provider.sent).toHaveLength(2);

    // Retry after the crash: the 3 claimed-but-unresolved rows must NOT be
    // re-claimed (the email may have left the building).
    const provider2 = new RecordingProvider();
    await sendCampaignBatch(message, deps(db, queue, provider2));
    expect(provider2.sent).toHaveLength(0);

    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(2);
    expect(rows.filter((r) => r.status === "sending")).toHaveLength(3);
  });

  it("skips suppressed recipients at send time", async () => {
    const { db, account, campaign } = await setupSendingCampaign();
    await addSuppression(db, {
      accountId: account.id,
      email: "bob@example.com",
      reason: "unsubscribe",
    });

    const provider = new RecordingProvider();
    await sendCampaignBatch(
      { campaignId: campaign.id, accountId: account.id, batchSize: 25 },
      deps(db, new FakeQueue(), provider),
    );

    expect(provider.sent.map((s) => s.toEmail)).not.toContain("bob@example.com");
    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(rows.find((r) => r.email === "bob@example.com")?.status).toBe("skipped");
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(4);
  });

  it("enforces the monthly email limit and pauses the campaign", async () => {
    const { db, account, campaign } = await setupSendingCampaign({
      limit: 3,
      sentCount: 0,
    });
    const queue = new FakeQueue();
    const provider = new RecordingProvider();
    const message = { campaignId: campaign.id, accountId: account.id, batchSize: 25 };

    await sendCampaignBatch(message, deps(db, queue, provider));
    // Quota allowed only 3 of 5.
    expect(provider.sent).toHaveLength(3);
    // A follow-up batch was enqueued for the remaining 2...
    expect(queue.messages.some((m) => m.type === "send_campaign_batch")).toBe(true);

    // ...and that batch pauses the campaign because the quota is exhausted.
    await sendCampaignBatch(message, deps(db, new FakeQueue(), provider));
    expect(provider.sent).toHaveLength(3);

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("paused");
    expect(fresh?.pausedReason).toContain("Monthly email limit");
  });

  it("counts only successful sends when the provider rate-limits mid-batch", async () => {
    const { db, account, campaign } = await setupSendingCampaign();
    const provider = new RecordingProvider();
    // 3rd send (index 2) hits a daily limit; the batch pauses there.
    provider.results.set(2, { provider: "mock", status: "rate_limited", error: "E_DAILY_LIMIT_EXCEEDED" });

    await sendCampaignBatch(
      { campaignId: campaign.id, accountId: account.id, batchSize: 25 },
      deps(db, new FakeQueue(), provider),
    );

    // 2 sent before the rate limit; the counter reflects exactly those.
    const freshAccount = await db.query.accounts.findFirst({
      where: eq(accounts.id, account.id),
    });
    expect(freshAccount?.monthlyEmailSentCount).toBe(2);

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("paused");

    // The unsent recipients are back to pending (not stuck in "sending").
    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(2);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(3);
  });

  it("never exceeds the monthly limit when two batches run concurrently", async () => {
    // Near-exhausted account: only 3 sends of quota remain, but 5 recipients
    // are pending and two batches race for them. With a read-then-write window
    // both batches would read sentCount=0, each claim 3, and jointly send 6.
    // The atomic reservation must bound the total at 3.
    const { db, account, campaign } = await setupSendingCampaign({ limit: 3, sentCount: 0 });
    const provider = new RecordingProvider();
    const message = { campaignId: campaign.id, accountId: account.id, batchSize: 5 };

    await Promise.all([
      sendCampaignBatch(message, deps(db, new FakeQueue(), provider)),
      sendCampaignBatch(message, deps(db, new FakeQueue(), provider)),
    ]);

    // The hard invariant: total emails handed to the provider never exceeds the
    // monthly limit, no matter how the two batches interleave.
    expect(provider.sent.length).toBeLessThanOrEqual(3);

    const freshAccount = await db.query.accounts.findFirst({
      where: eq(accounts.id, account.id),
    });
    // The counter reflects exactly the emails sent and is itself capped.
    expect(freshAccount!.monthlyEmailSentCount).toBe(provider.sent.length);
    expect(freshAccount!.monthlyEmailSentCount).toBeLessThanOrEqual(3);

    // Sent recipients are not double-counted: each sent row is distinct.
    const sentRows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(sentRows.filter((r) => r.status === "sent")).toHaveLength(provider.sent.length);
  });

  it("renders unsubscribe links and footer into the sent email", async () => {
    const { db, account, campaign } = await setupSendingCampaign();
    const provider = new RecordingProvider();
    await sendCampaignBatch(
      { campaignId: campaign.id, accountId: account.id, batchSize: 25 },
      deps(db, new FakeQueue(), provider),
    );

    const email = provider.sent.find((s) => s.toEmail === "alice@example.com")!;
    expect(email.html).toContain("/unsubscribe?token=");
    expect(email.html).toContain("Unsubscribe");
    expect(email.html).toContain("Hi alice,"); // {{first_name}} substituted
    expect(email.headers?.["List-Unsubscribe"]).toContain("http");
  });
});

describe("campaignPersonalizationGaps", () => {
  // Seed an audience where some subscribed members are missing a first name.
  async function seedMixedAudience() {
    const db = await testDb();
    const account = await seedAccount(db);
    const domain = await seedDomain(db, account.id);
    const audience = await seedAudience(db, account.id);
    const now = nowIso();
    const sub = (
      email: string,
      firstName: string | null,
      status: "subscribed" | "unsubscribed" = "subscribed",
    ) => ({
      id: newId("sub"),
      accountId: account.id,
      audienceId: audience.id,
      email,
      firstName,
      status,
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(subscribers).values([
      sub("a@x.co", "Alice"),
      sub("b@x.co", "Bob"),
      sub("c@x.co", null),
      sub("d@x.co", ""), // empty counts as missing
      sub("e@x.co", null),
      sub("f@x.co", null, "unsubscribed"), // not a recipient — excluded
    ]);
    return { db, account, domain, audience };
  }

  it("counts subscribed recipients missing a field the campaign uses", async () => {
    const { db, account, domain, audience } = await seedMixedAudience();
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      subject: "Hi {{first_name|there}}",
      htmlBody: "<p>Hi {{first_name|there}}, welcome.</p>",
    });

    const gaps = await campaignPersonalizationGaps(db, account.id, campaign);
    // 3 of 5 subscribed members (c, d, e) have no first name; the unsubscribed one
    // is excluded from both counts.
    expect(gaps).toEqual([{ field: "first_name", fallback: "there", missing: 3, total: 5 }]);
  });

  it("flags a bare tag as a blank (null fallback)", async () => {
    const { db, account, domain, audience } = await seedMixedAudience();
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      htmlBody: "<p>Hi {{first_name}}</p>", // no fallback
    });
    const gaps = await campaignPersonalizationGaps(db, account.id, campaign);
    expect(gaps).toEqual([{ field: "first_name", fallback: null, missing: 3, total: 5 }]);
  });

  it("returns nothing when no recipient is missing the used field", async () => {
    const { db, account, domain, audience } = await seedMixedAudience();
    // last_name is used, but nobody has one either — wait, that's missing for all.
    // Use a campaign that personalizes nothing instead.
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      subject: "Monthly update",
      htmlBody: "<p>No personalization here.</p>",
    });
    expect(await campaignPersonalizationGaps(db, account.id, campaign)).toEqual([]);
  });
});
