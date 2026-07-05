import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { sendCampaignBatch } from "../src/queue/handlers/send-batch";
import { generateCampaignRecipients } from "../src/queue/handlers/generate-recipients";
import { campaignRecipients, campaigns, accounts, notifications, subscribers } from "../src/db/schema";
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

async function setupSendingCampaign(
  opts: { limit?: number; sentCount?: number; emails?: string[] } = {},
) {
  const db = await testDb();
  const account = await seedAccount(db, {
    monthlyEmailLimit: opts.limit ?? 10_000,
    monthlyEmailSentCount: opts.sentCount ?? 0,
  });
  const domain = await seedDomain(db, account.id);
  const audience = await seedAudience(db, account.id);
  await seedSubscribers(db, account.id, audience.id, opts.emails ?? TEST_EMAILS);
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

  it("recovers a mid-batch crash without ever resending a handed-off email", async () => {
    const { db, account, campaign } = await setupSendingCampaign();
    const queue = new FakeQueue();
    const provider = new RecordingProvider();
    provider.throwOnCall = 2; // provider throws while recipient #3 is in flight
    const message = { campaignId: campaign.id, accountId: account.id, batchSize: 25 };

    await expect(sendCampaignBatch(message, deps(db, queue, provider))).rejects.toThrow(
      "provider exploded",
    );
    expect(provider.sent).toHaveLength(2);

    // The recipient whose provider call was in flight is ambiguous — the email
    // may have left the building — so it must stay claimed ("sending", for the
    // stuck-lock sweep to fail later), while the untouched remainder returns to
    // pending. The quota reservation must be reconciled down to actual sends.
    let rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(2);
    expect(rows.filter((r) => r.status === "sending")).toHaveLength(1);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(2);
    const account1 = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(account1?.monthlyEmailSentCount).toBe(2);

    // Retry after the crash: only the returned-to-pending rows are re-claimed;
    // the ambiguous row is not, and nobody receives the email twice.
    const provider2 = new RecordingProvider();
    await sendCampaignBatch(message, deps(db, queue, provider2));
    expect(provider2.sent).toHaveLength(2);
    const allSentEmails = [...provider.sent, ...provider2.sent].map((s) => s.toEmail);
    expect(new Set(allSentEmails).size).toBe(allSentEmails.length);

    rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(4);
    expect(rows.filter((r) => r.status === "sending")).toHaveLength(1);
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

    // Machine-readable pause cause (the sweep's auto-resume keys on it) and a
    // user-facing notification — a silent pause is a stalled campaign nobody
    // knows about.
    expect(fresh?.pausedCode).toBe("daily_limit");
    const pauseNotes = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.accountId, account.id), eq(notifications.kind, "campaign_paused")),
      );
    expect(pauseNotes).toHaveLength(1);
  });

  it("drains a campaign with concurrent lanes: no duplicates, exactly one completion", async () => {
    const emails = Array.from({ length: 30 }, (_, i) => `lane${i}@example.com`);
    const { db, account, campaign } = await setupSendingCampaign({ emails });
    const provider = new RecordingProvider();
    const message = { campaignId: campaign.id, accountId: account.id, batchSize: 5 };

    // Waves of 4 concurrent lanes racing over the same pending set, like
    // production workers do. FOR UPDATE SKIP LOCKED must hand each lane a
    // disjoint slice, and the completion UPDATE's status guard must let exactly
    // one racer own the "campaign sent" transition.
    for (let wave = 0; wave < 12; wave++) {
      await Promise.all(
        Array.from({ length: 4 }, () =>
          sendCampaignBatch(message, deps(db, new FakeQueue(), provider)),
        ),
      );
      const remaining = await db
        .select({ id: campaignRecipients.id })
        .from(campaignRecipients)
        .where(
          and(
            eq(campaignRecipients.campaignId, campaign.id),
            eq(campaignRecipients.status, "pending"),
          ),
        )
        .limit(1);
      if (remaining.length === 0) break;
    }

    // Every recipient exactly once — the core exactly-once invariant.
    expect(provider.sent).toHaveLength(30);
    expect(new Set(provider.sent.map((s) => s.toEmail)).size).toBe(30);

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sent");

    const freshAccount = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(freshAccount?.monthlyEmailSentCount).toBe(30);

    const sentNotes = await db
      .select()
      .from(notifications)
      .where(
        and(eq(notifications.accountId, account.id), eq(notifications.kind, "campaign_sent")),
      );
    expect(sentNotes).toHaveLength(1);
  });

  it("returns the whole remainder (including the in-flight recipient) to pending on a transient error and throws for retry", async () => {
    const { db, account, campaign } = await setupSendingCampaign();
    const provider = new RecordingProvider();
    // 3rd send hits a connection-phase failure — provably never reached SES.
    provider.results.set(2, {
      provider: "mock",
      status: "transient",
      error: "ENOTFOUND: getaddrinfo ENOTFOUND email.eu-north-1.amazonaws.com",
    });
    const message = { campaignId: campaign.id, accountId: account.id, batchSize: 25 };

    await expect(sendCampaignBatch(message, deps(db, new FakeQueue(), provider))).rejects.toThrow(
      /transient provider error/,
    );

    // Unlike the crash case, the in-flight recipient is provably unsent — it
    // goes back to pending too, and nothing is left for the sweep to fail.
    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(2);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(3);
    expect(rows.filter((r) => r.status === "sending")).toHaveLength(0);
    const account1 = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(account1?.monthlyEmailSentCount).toBe(2);

    // The BullMQ retry (same message) finishes the job without duplicates.
    const provider2 = new RecordingProvider();
    await sendCampaignBatch(message, deps(db, new FakeQueue(), provider2));
    expect(provider2.sent).toHaveLength(3);
    const all = [...provider.sent, ...provider2.sent].map((s) => s.toEmail);
    expect(new Set(all).size).toBe(5);
    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sent");
  });

  it("clamps a malformed batchSize instead of pausing the campaign with a false quota message", async () => {
    const { db, account, campaign } = await setupSendingCampaign();
    const provider = new RecordingProvider();

    // NaN batchSize (env typo serialized through job data) must fall back to
    // the default batch size — the old behavior fed NaN into the quota
    // reservation, which granted 0 and paused the campaign claiming the
    // monthly limit was reached.
    await sendCampaignBatch(
      { campaignId: campaign.id, accountId: account.id, batchSize: Number.NaN },
      deps(db, new FakeQueue(), provider),
    );

    expect(provider.sent).toHaveLength(5);
    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sent");
  });

  it("trips the circuit breaker on repeated identical failures instead of burning the audience", async () => {
    const emails = Array.from({ length: 15 }, (_, i) => `cb${i}@example.com`);
    const { db, account, campaign } = await setupSendingCampaign({ emails });
    const provider = new RecordingProvider();
    for (let i = 0; i < 15; i++) {
      provider.results.set(i, {
        provider: "mock",
        status: "failed",
        error: "UnknownError: identical provider failure",
      });
    }

    await sendCampaignBatch(
      { campaignId: campaign.id, accountId: account.id, batchSize: 25 },
      deps(db, new FakeQueue(), provider),
    );

    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    // 10 consecutive identical failures trip the breaker; the remaining 5 stay
    // recoverable (pending) instead of being ground to terminal failed.
    expect(rows.filter((r) => r.status === "failed")).toHaveLength(10);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(5);

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("paused");
    expect(fresh?.pausedCode).toBe("error");
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
