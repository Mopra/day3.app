import { describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  campaignRecipients,
  campaigns,
  accounts,
  imports,
  subscribers,
  emailEvents,
  suppressionEntries,
} from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { addSuppression } from "../src/services/suppression";
import { handleQueueMessage, type QueueDeps } from "../src/queue/consumer";
import { COMPLAINT_RATE_PAUSE } from "../src/services/health";
import type { Db } from "../src/db/client";
import {
  FakeQueue,
  FakeStore,
  RecordingProvider,
  seedAccount,
  seedAudience,
  seedCampaign,
  seedDomain,
  testDb,
} from "./helpers";

// A queue that drains itself through the real consumer. Enqueuing the first
// message and draining replays the exact production fan-out: review_campaign
// enqueues generate_campaign_recipients, which enqueues send_campaign_batch,
// which re-enqueues itself until the campaign is sent. Each follow-up job runs
// through handleQueueMessage just as the BullMQ worker would.
class DrainingQueue extends FakeQueue {
  async drain(deps: Omit<QueueDeps, "queue">): Promise<void> {
    let guard = 0;
    while (this.messages.length > 0) {
      if (guard++ > 1000) throw new Error("drain did not converge — possible job loop");
      const message = this.messages.shift()!;
      await handleQueueMessage(message, { ...deps, queue: this });
    }
  }
}

function deps(db: Db, store: FakeStore, provider: RecordingProvider): Omit<QueueDeps, "queue"> {
  return {
    db,
    emailProvider: provider,
    store,
    appUrl: "http://localhost:5173",
    unsubscribeSecret: "test-secret",
    aiReviewMode: "mock",
  };
}

// Builds a many-row CSV so account health (which needs >= 50 attempted sends to
// enforce) has enough volume to act on in the webhook test.
function csvFor(emails: string[]): string {
  return ["email,first_name", ...emails.map((e) => `${e},${e.split("@")[0]}`)].join("\n");
}

function manyEmails(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `user${i}@example.com`);
}

// Seed an account + verified domain + audience, then drive a real CSV import
// through the queue so the audience is populated exactly as in production.
async function onboardAndImport(
  db: Db,
  store: FakeStore,
  provider: RecordingProvider,
  emails: string[],
) {
  const account = await seedAccount(db);
  const domain = await seedDomain(db, account.id);
  const audience = await seedAudience(db, account.id);

  const importId = newId("imp");
  const r2Key = `imports/${account.id}/${importId}.csv`;
  store.put(r2Key, csvFor(emails));
  const now = nowIso();
  await db.insert(imports).values({
    id: importId,
    accountId: account.id,
    audienceId: audience.id,
    r2Key,
    filename: "subscribers.csv",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  const queue = new DrainingQueue();
  await queue.send({ type: "process_import", importId, accountId: account.id });
  await queue.drain(deps(db, store, provider));

  const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
  expect(importRow?.status).toBe("completed");

  return { account, domain, audience };
}

// Submit a draft campaign for review and drive it all the way to a terminal
// state through the queue. Returns the (possibly draining) queue so callers can
// inspect what was enqueued.
async function submitAndDrive(
  db: Db,
  store: FakeStore,
  provider: RecordingProvider,
  campaignId: string,
  accountId: string,
): Promise<DrainingQueue> {
  // The web tier flips draft -> pending_review then enqueues review_campaign.
  await db
    .update(campaigns)
    .set({ status: "pending_review", updatedAt: nowIso() })
    .where(eq(campaigns.id, campaignId));
  const queue = new DrainingQueue();
  await queue.send({ type: "review_campaign", campaignId, accountId });
  await queue.drain(deps(db, store, provider));
  return queue;
}

describe("end-to-end: sign-up to sent", () => {
  it("drives a campaign from draft to sent through the real queue fan-out", async () => {
    const db = await testDb();
    const store = new FakeStore();
    const provider = new RecordingProvider();
    const emails = manyEmails(5);

    const { account, audience, domain } = await onboardAndImport(db, store, provider, emails);

    // Imported subscribers exist and are subscribed.
    const subs = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.audienceId, audience.id));
    expect(subs).toHaveLength(5);
    expect(subs.every((s) => s.status === "subscribed")).toBe(true);

    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "draft",
    });

    await submitAndDrive(db, store, provider, campaign.id, account.id);

    // The campaign reached "sent".
    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sent");
    expect(fresh?.riskLevel).toBe("low");
    expect(fresh?.sentAt).toBeTruthy();

    // Every recipient was sent, with a provider message id, exactly once.
    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(rows).toHaveLength(5);
    expect(rows.every((r) => r.status === "sent")).toBe(true);
    expect(rows.every((r) => r.providerMessageId)).toBe(true);
    expect(provider.sent).toHaveLength(5);

    // The usage counter reflects exactly the emails sent.
    const acc = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(acc?.monthlyEmailSentCount).toBe(5);

    // "sent" events were emitted for each recipient and account health is normal.
    const events = await db
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.campaignId, campaign.id));
    expect(events.filter((e) => e.eventType === "sent")).toHaveLength(5);
    expect(acc?.riskStatus).toBe("normal");
    expect(acc?.sendingEnabled).toBe(true);
  });
});

describe("end-to-end failure paths", () => {
  it("pauses on a provider rate limit, then resumes without duplicate sends", async () => {
    const db = await testDb();
    const store = new FakeStore();
    const provider = new RecordingProvider();
    const emails = manyEmails(5);
    const { account, audience, domain } = await onboardAndImport(db, store, provider, emails);

    // The 3rd send hits the provider's daily limit; the batch pauses there.
    provider.results.set(2, {
      provider: "mock",
      status: "rate_limited",
      error: "E_DAILY_LIMIT_EXCEEDED",
    });

    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "draft",
    });
    await submitAndDrive(db, store, provider, campaign.id, account.id);

    let fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("paused");
    expect(fresh?.pausedReason).toMatch(/daily sending limit/i);
    // 2 accepted before the limit; the remaining 3 are back to pending (not
    // stuck in "sending"). The usage counter reflects only the 2 that sent.
    const afterPause = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(afterPause.filter((r) => r.status === "sent")).toHaveLength(2);
    expect(afterPause.filter((r) => r.status === "pending")).toHaveLength(3);
    const pausedAcc = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(pausedAcc?.monthlyEmailSentCount).toBe(2);

    // The provider recovers; an operator resumes the campaign. The same handler
    // path re-runs and finishes the remaining 3 — never re-sending the first 2.
    provider.results.clear();
    await db
      .update(campaigns)
      .set({ status: "sending", pausedReason: null, updatedAt: nowIso() })
      .where(eq(campaigns.id, campaign.id));
    const resume = new DrainingQueue();
    await resume.send({
      type: "send_campaign_batch",
      campaignId: campaign.id,
      accountId: account.id,
      batchSize: 25,
    });
    await resume.drain(deps(db, store, provider));

    fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sent");
    const finalRows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(finalRows.filter((r) => r.status === "sent")).toHaveLength(5);
    // No address was accepted twice: each of the 5 recipients has a distinct
    // provider message id, so the resume re-claimed only the 3 still-pending
    // rows and never re-sent the 2 already delivered before the pause.
    const messageIds = finalRows.map((r) => r.providerMessageId);
    expect(new Set(messageIds).size).toBe(5);
    // The successful (status === "sent") accepts across pause+resume are exactly
    // the 5 distinct recipients — the rate-limited attempt was not an accept.
    const accepts = provider.sent.filter((s) =>
      finalRows.some((r) => r.email === s.toEmail && r.status === "sent"),
    );
    expect(new Set(accepts.map((s) => s.toEmail)).size).toBe(5);

    const acc = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(acc?.monthlyEmailSentCount).toBe(5);
  });

  it("pauses the campaign when the sender domain is not verified", async () => {
    const db = await testDb();
    const store = new FakeStore();
    const provider = new RecordingProvider();
    const { account, audience, domain } = await onboardAndImport(db, store, provider, manyEmails(5));

    // The first send is rejected by the provider as an unverified sender.
    provider.results.set(0, {
      provider: "mock",
      status: "failed",
      error: "E_SENDER_NOT_VERIFIED: identity not verified",
    });

    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "draft",
    });
    await submitAndDrive(db, store, provider, campaign.id, account.id);

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("paused");
    expect(fresh?.pausedReason).toMatch(/not verified/i);

    // No recipient was accepted; all 5 are returned to pending (none "sent"),
    // and the domain is flipped back to failed so it gets re-checked.
    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(0);
    expect(rows.filter((r) => r.status === "pending")).toHaveLength(5);

    const acc = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(acc?.monthlyEmailSentCount).toBe(0);

    const dom = await db.query.sendingDomains.findFirst({
      where: (t, { eq: e }) => e(t.id, domain.id),
    });
    expect(dom?.verificationStatus).toBe("failed");
  });

  it("skips a recipient suppressed after recipients were generated", async () => {
    const db = await testDb();
    const store = new FakeStore();
    const provider = new RecordingProvider();
    const emails = manyEmails(5);
    const { account, audience, domain } = await onboardAndImport(db, store, provider, emails);

    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "draft",
    });

    // Suppress one address before sending. generate_recipients excludes it from
    // the generated set; even if a race let it through, send-time re-checks it.
    await addSuppression(db, {
      accountId: account.id,
      email: emails[1],
      reason: "unsubscribe",
    });

    await submitAndDrive(db, store, provider, campaign.id, account.id);

    const fresh = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaign.id) });
    expect(fresh?.status).toBe("sent");

    // The suppressed address was never sent to.
    expect(provider.sent.map((s) => s.toEmail)).not.toContain(emails[1]);
    expect(provider.sent).toHaveLength(4);

    const rows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    // It was excluded at generation time, so no recipient row exists for it.
    expect(rows.map((r) => r.email)).not.toContain(emails[1]);
    expect(rows.filter((r) => r.status === "sent")).toHaveLength(4);

    const acc = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(acc?.monthlyEmailSentCount).toBe(4);
  });
});

// The webhook route resolves its DB via getDb() and validates the SNS signature
// via sns-payload-validator. Both are seams we replace so the handler runs
// against the hermetic pglite DB with a pre-validated payload — mirroring
// ses-webhook.test.ts, but here we feed a full delivery+bounce+complaint stream
// across a real sent campaign and assert the resulting health/auto-pause.
let currentDb: Db;
vi.mock("../src/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/client")>();
  return { ...actual, getDb: () => currentDb };
});
vi.mock("sns-payload-validator", () => ({
  default: class {
    async validate(raw: string) {
      return JSON.parse(raw);
    }
  },
}));

const { POST } = await import("../app/api/webhooks/ses/route");

function snsNotification(messageId: string, event: Record<string, unknown>) {
  return {
    Type: "Notification",
    MessageId: `sns-${messageId}`,
    TopicArn: "arn:aws:sns:eu-west-1:123456789012:ses-events",
    Message: JSON.stringify({ ...event, mail: { messageId, destination: [] } }),
  };
}

function post(envelope: unknown): Promise<Response> {
  const req = new Request("http://localhost/api/webhooks/ses", {
    method: "POST",
    body: JSON.stringify(envelope),
  });
  return POST(req as never);
}

describe("end-to-end: webhook ingestion drives status, suppression, and auto-pause", () => {
  it("ingests delivery, bounce and complaint events and auto-pauses past threshold", async () => {
    currentDb = await testDb();
    const db = currentDb;
    const store = new FakeStore();
    const provider = new RecordingProvider();

    // A large enough audience that the complaint-rate enforcement (which needs
    // >= 50 attempted sends) can act. 2000 sends, then one complaint puts the
    // rate at 0.0005 — below pause (0.0008); a second pushes it over.
    const emails = manyEmails(2000);
    const { account, audience, domain } = await onboardAndImport(db, store, provider, emails);

    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "draft",
    });
    await submitAndDrive(db, store, provider, campaign.id, account.id);

    const sentRows = await db
      .select()
      .from(campaignRecipients)
      .where(eq(campaignRecipients.campaignId, campaign.id));
    expect(sentRows).toHaveLength(2000);
    expect(sentRows.every((r) => r.status === "sent" && r.providerMessageId)).toBe(true);

    const byEmail = new Map(sentRows.map((r) => [r.email, r]));
    const mid = (email: string) => byEmail.get(email)!.providerMessageId!;

    // 1) A delivery moves the recipient to "delivered".
    const delivered = emails[0];
    expect((await post(snsNotification(mid(delivered), { eventType: "Delivery" }))).status).toBe(
      200,
    );
    let rec = byEmail.get(delivered)!;
    let fresh = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, rec.id),
    });
    expect(fresh?.status).toBe("delivered");

    // 2) A permanent bounce suppresses the address and marks the recipient.
    const bouncer = emails[1];
    expect(
      (
        await post(
          snsNotification(mid(bouncer), {
            eventType: "Bounce",
            bounce: { bounceType: "Permanent", bouncedRecipients: [{ emailAddress: bouncer }] },
          }),
        )
      ).status,
    ).toBe(200);
    rec = byEmail.get(bouncer)!;
    fresh = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, rec.id),
    });
    expect(fresh?.status).toBe("bounced");
    const bounceSup = await db
      .select()
      .from(suppressionEntries)
      .where(eq(suppressionEntries.email, bouncer));
    expect(bounceSup).toHaveLength(1);
    expect(bounceSup[0].reason).toBe("hard_bounce");

    // 3) A single complaint suppresses but is below the auto-pause threshold.
    const complainer1 = emails[2];
    expect(
      (await post(snsNotification(mid(complainer1), { eventType: "Complaint" }))).status,
    ).toBe(200);
    rec = byEmail.get(complainer1)!;
    fresh = await db.query.campaignRecipients.findFirst({
      where: eq(campaignRecipients.id, rec.id),
    });
    expect(fresh?.status).toBe("complained");
    let acc = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    // 1 complaint / 2000 attempted = 0.0005 < pause (0.0008): still sending.
    expect(1 / 2000).toBeLessThan(COMPLAINT_RATE_PAUSE);
    expect(acc?.sendingEnabled).toBe(true);
    expect(acc?.riskStatus).toBe("normal");

    // 4) A second complaint pushes the rate over the threshold → auto-pause.
    const complainer2 = emails[3];
    expect(
      (await post(snsNotification(mid(complainer2), { eventType: "Complaint" }))).status,
    ).toBe(200);
    acc = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    expect(2 / 2000).toBeGreaterThanOrEqual(COMPLAINT_RATE_PAUSE);
    expect(acc?.sendingEnabled).toBe(false);
    expect(acc?.riskStatus).toBe("paused");
    expect(acc?.pausedReason).toMatch(/complaint rate/i);

    // Suppression list now holds the bounce + both complaints.
    const allSup = await db
      .select()
      .from(suppressionEntries)
      .where(inArray(suppressionEntries.email, [bouncer, complainer1, complainer2]));
    expect(allSup).toHaveLength(3);

    // Re-delivering the second complaint is idempotent: still one event row, the
    // account stays paused (health enforcement does not re-fire on the no-op).
    expect(
      (await post(snsNotification(mid(complainer2), { eventType: "Complaint" }))).status,
    ).toBe(200);
    const complaintEvents = await db
      .select()
      .from(emailEvents)
      .where(eq(emailEvents.eventType, "complaint"));
    expect(complaintEvents).toHaveLength(2);
    // 2,000 real sends through the full pipeline in WASM Postgres: ~9s alone,
    // but the parallel suite runs many pglite instances at once — give it
    // headroom so CPU contention can't flake it at the default 30s.
  }, 120_000);
});
