import { describe, expect, it } from "vitest";
import {
  accountAutomationMetrics,
  accountCampaignMetrics,
  accountTransactionalMetrics,
} from "../src/services/metrics";
import { computeAccountHealth } from "../src/services/health";
import {
  campaignRecipients,
  emailEvents,
  transactionalEmails,
  type RecipientStatus,
  type TransactionalEmailStatus,
} from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import type { Db } from "../src/db/client";
import {
  seedAccount,
  seedAudience,
  seedAutomation,
  seedCampaign,
  seedDomain,
  testDb,
} from "./helpers";

// Insert a campaign recipient with explicit lifecycle timestamps so the
// aggregation's FILTER counts can be asserted exactly.
async function addRecipient(
  db: Db,
  accountId: string,
  campaignId: string,
  status: RecipientStatus,
  stamps: Partial<{
    sentAt: string;
    deliveredAt: string;
    openedAt: string;
    clickedAt: string;
    bouncedAt: string;
    complainedAt: string;
    unsubscribedAt: string;
  }>,
): Promise<void> {
  const now = nowIso();
  await db.insert(campaignRecipients).values({
    id: newId("rcp"),
    campaignId,
    accountId,
    email: `${newId("e")}@example.com`,
    status,
    createdAt: now,
    updatedAt: now,
    ...stamps,
  });
}

describe("accountCampaignMetrics", () => {
  it("counts each outcome independently from the timestamp columns", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const domain = await seedDomain(db, account.id);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "sent",
    });
    const t = nowIso();

    // 2 delivered + opened; one of them also clicked
    await addRecipient(db, account.id, campaign.id, "delivered", { sentAt: t, deliveredAt: t, openedAt: t, clickedAt: t });
    await addRecipient(db, account.id, campaign.id, "delivered", { sentAt: t, deliveredAt: t, openedAt: t });
    // 1 delivered, not opened
    await addRecipient(db, account.id, campaign.id, "delivered", { sentAt: t, deliveredAt: t });
    // 1 bounced
    await addRecipient(db, account.id, campaign.id, "bounced", { sentAt: t, bouncedAt: t });
    // 1 delivered then complained
    await addRecipient(db, account.id, campaign.id, "complained", { sentAt: t, deliveredAt: t, complainedAt: t });
    // 1 delivered then unsubscribed
    await addRecipient(db, account.id, campaign.id, "unsubscribed", { sentAt: t, deliveredAt: t, unsubscribedAt: t });
    // 1 failed (never sent) and 1 skipped (suppressed)
    await addRecipient(db, account.id, campaign.id, "failed", {});
    await addRecipient(db, account.id, campaign.id, "skipped", {});

    const rows = await accountCampaignMetrics(db, account.id);
    expect(rows).toHaveLength(1);
    const c = rows[0].counts;
    expect(rows[0].campaignId).toBe(campaign.id);
    expect(c.recipients).toBe(8);
    expect(c.sent).toBe(6); // everything with a sent_at
    expect(c.delivered).toBe(5);
    expect(c.opened).toBe(2);
    expect(c.clicked).toBe(1);
    expect(c.bounced).toBe(1);
    expect(c.complained).toBe(1);
    expect(c.unsubscribed).toBe(1);
    expect(c.failed).toBe(1);
    expect(c.skipped).toBe(1);
  });

  it("returns one row per campaign and never leaks across accounts", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const domain = await seedDomain(db, account.id);
    const t = nowIso();

    const a = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "sent",
    });
    const b = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "sent",
    });
    await addRecipient(db, account.id, a.id, "delivered", { sentAt: t, deliveredAt: t });
    await addRecipient(db, account.id, b.id, "sent", { sentAt: t });

    // A second account with its own send — must not appear in the first's metrics.
    const other = await seedAccount(db);
    const otherAud = await seedAudience(db, other.id);
    const otherDom = await seedDomain(db, other.id);
    const otherCampaign = await seedCampaign(db, {
      accountId: other.id,
      audienceId: otherAud.id,
      sendingDomainId: otherDom.id,
      status: "sent",
    });
    await addRecipient(db, other.id, otherCampaign.id, "delivered", { sentAt: t, deliveredAt: t });

    const rows = await accountCampaignMetrics(db, account.id);
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.campaignId).sort();
    expect(ids).toEqual([a.id, b.id].sort());
  });

  it("returns nothing for an account with no recipients", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    expect(await accountCampaignMetrics(db, account.id)).toEqual([]);
  });
});

/* ─────────────────────────── automation metrics ─────────────────────────── */

// An automation send: the same ledger, campaign_id NULL and automation_id set.
async function addAutomationSend(
  db: Db,
  accountId: string,
  automationId: string,
  nodeKey: string,
  status: RecipientStatus,
  stamps: Partial<{
    sentAt: string;
    deliveredAt: string;
    openedAt: string;
    clickedAt: string;
    bouncedAt: string;
    complainedAt: string;
    unsubscribedAt: string;
  }>,
): Promise<void> {
  const now = nowIso();
  await db.insert(campaignRecipients).values({
    id: newId("rcp"),
    campaignId: null,
    automationId,
    automationEnrollmentId: newId("aen"),
    automationNodeKey: nodeKey,
    accountId,
    email: `${newId("e")}@example.com`,
    status,
    createdAt: now,
    updatedAt: now,
    ...stamps,
  });
}

describe("accountAutomationMetrics", () => {
  it("aggregates automation sends and keeps them out of the campaign rows", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const domain = await seedDomain(db, account.id);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "sent",
    });
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: { nodes: [], edges: [] },
      name: "Welcome series",
    });
    const older = new Date(Date.now() - 60_000).toISOString();
    const t = nowIso();

    await addRecipient(db, account.id, campaign.id, "delivered", { sentAt: t, deliveredAt: t });
    await addAutomationSend(db, account.id, automation.id, "send1", "delivered", {
      sentAt: older,
      deliveredAt: older,
      openedAt: older,
    });
    await addAutomationSend(db, account.id, automation.id, "send1", "delivered", {
      sentAt: t,
      deliveredAt: t,
    });
    await addAutomationSend(db, account.id, automation.id, "send2", "bounced", {
      sentAt: t,
      bouncedAt: t,
    });

    const rows = await accountAutomationMetrics(db, account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].automationId).toBe(automation.id);
    expect(rows[0].name).toBe("Welcome series");
    expect(rows[0].counts.recipients).toBe(3);
    expect(rows[0].counts.sent).toBe(3);
    expect(rows[0].counts.delivered).toBe(2);
    expect(rows[0].counts.opened).toBe(1);
    expect(rows[0].counts.bounced).toBe(1);
    // Continuous sender: "last sent" is the max over its rows, not one date.
    expect(rows[0].lastSentAt).toBe(t);

    // The campaign table must not have picked up the automation's three sends.
    const campaignRows = await accountCampaignMetrics(db, account.id);
    expect(campaignRows).toHaveLength(1);
    expect(campaignRows[0].counts.recipients).toBe(1);
  });

  it("returns nothing for an account with no automation sends", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    expect(await accountAutomationMetrics(db, account.id)).toEqual([]);
  });
});

/* ────────────────────────── transactional metrics ───────────────────────── */

async function addTransactional(
  db: Db,
  accountId: string,
  input: {
    fromEmail: string;
    to: string[];
    status: TransactionalEmailStatus;
    sent?: boolean;
    delivered?: boolean;
    /** Addresses that hard-bounced, written as email_events rows like SES does. */
    bounced?: string[];
    /** A soft bounce — recorded as an event but never counted. */
    softBounced?: string[];
    complained?: string[];
  },
): Promise<void> {
  const now = nowIso();
  const id = newId("txe");
  await db.insert(transactionalEmails).values({
    id,
    accountId,
    fromEmail: input.fromEmail,
    to: input.to,
    subject: "Your receipt",
    htmlBody: "<p>Thanks</p>",
    status: input.status,
    providerMessageId: newId("msg"),
    sentAt: input.sent === false ? null : now,
    deliveredAt: input.delivered ? now : null,
    createdAt: now,
    updatedAt: now,
  });
  const events: { email: string; type: "bounce" | "complaint"; payload: string }[] = [
    ...(input.bounced ?? []).map((email) => ({
      email,
      type: "bounce" as const,
      payload: JSON.stringify({ bounce: { bounceType: "Permanent" } }),
    })),
    ...(input.softBounced ?? []).map((email) => ({
      email,
      type: "bounce" as const,
      payload: JSON.stringify({ bounce: { bounceType: "Transient" } }),
    })),
    ...(input.complained ?? []).map((email) => ({
      email,
      type: "complaint" as const,
      payload: JSON.stringify({ complaint: {} }),
    })),
  ];
  for (const e of events) {
    await db.insert(emailEvents).values({
      id: newId("evt"),
      accountId,
      transactionalEmailId: id,
      eventType: e.type,
      email: e.email,
      provider: "ses",
      providerMessageId: newId("msg"),
      payloadJson: e.payload,
      createdAt: now,
    });
  }
}

describe("accountTransactionalMetrics", () => {
  it("counts volume in addresses, not messages, and splits by From", async () => {
    const db = await testDb();
    const account = await seedAccount(db);

    // One digest addressing 10 people, plus two single receipts.
    await addTransactional(db, account.id, {
      fromEmail: "digest@acme.test",
      to: Array.from({ length: 10 }, (_, i) => `u${i}@example.com`),
      status: "delivered",
      delivered: true,
    });
    await addTransactional(db, account.id, {
      fromEmail: "billing@acme.test",
      to: ["a@example.com"],
      status: "delivered",
      delivered: true,
    });
    await addTransactional(db, account.id, {
      fromEmail: "billing@acme.test",
      to: ["b@example.com"],
      status: "sent",
    });

    const { totals, senders } = await accountTransactionalMetrics(db, account.id);
    expect(totals.messages).toBe(3);
    expect(totals.emails).toBe(12);
    expect(totals.sent).toBe(12);
    expect(totals.delivered).toBe(11);
    expect(senders).toHaveLength(2);
    const billing = senders.find((s) => s.fromEmail === "billing@acme.test")!;
    expect(billing.counts.messages).toBe(2);
    expect(billing.counts.emails).toBe(2);
    const digest = senders.find((s) => s.fromEmail === "digest@acme.test")!;
    expect(digest.counts.messages).toBe(1);
    expect(digest.counts.emails).toBe(10);
  });

  it("counts the ADDRESSES that bounced, not every recipient of the message", async () => {
    // The same regression services/health.ts guards: a bounce for one recipient
    // flips the whole message's status, so reading `bounced` off the message row
    // would charge all 50 addresses of one message with one dead mailbox.
    const db = await testDb();
    const account = await seedAccount(db);
    await addTransactional(db, account.id, {
      fromEmail: "digest@acme.test",
      to: Array.from({ length: 50 }, (_, i) => `u${i}@example.com`),
      status: "bounced",
      bounced: ["u7@example.com"],
    });

    const { totals } = await accountTransactionalMetrics(db, account.id);
    expect(totals.emails).toBe(50);
    expect(totals.bounced).toBe(1);
  });

  it("ignores soft bounces, as the reputation guard does", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await addTransactional(db, account.id, {
      fromEmail: "billing@acme.test",
      to: ["a@example.com"],
      status: "sent",
      softBounced: ["a@example.com"],
    });

    const { totals } = await accountTransactionalMetrics(db, account.id);
    expect(totals.bounced).toBe(0);
  });

  it("weighs failed and suppressed messages by every address that missed out", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await addTransactional(db, account.id, {
      fromEmail: "security@acme.test",
      to: ["a@example.com", "b@example.com"],
      status: "failed",
      sent: false,
    });
    await addTransactional(db, account.id, {
      fromEmail: "security@acme.test",
      to: ["c@example.com"],
      status: "suppressed",
      sent: false,
    });
    await addTransactional(db, account.id, {
      fromEmail: "security@acme.test",
      to: ["d@example.com"],
      status: "queued",
      sent: false,
    });

    const { totals } = await accountTransactionalMetrics(db, account.id);
    expect(totals.emails).toBe(4);
    expect(totals.sent).toBe(0);
    expect(totals.failed).toBe(2);
    expect(totals.suppressed).toBe(1);
    expect(totals.queued).toBe(1);
  });

  it("never leaks another account's transactional sends", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const other = await seedAccount(db);
    await addTransactional(db, other.id, {
      fromEmail: "billing@other.test",
      to: ["x@example.com"],
      status: "delivered",
      delivered: true,
    });

    const { totals, senders } = await accountTransactionalMetrics(db, account.id);
    expect(senders).toEqual([]);
    expect(totals.emails).toBe(0);
  });
});

/* ─────────────────── reputation, split by what sent the mail ────────────── */

describe("computeAccountHealth bySource", () => {
  it("splits the window by producer and sums exactly to the headline", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const domain = await seedDomain(db, account.id);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
      status: "sent",
    });
    const { automation } = await seedAutomation(db, {
      accountId: account.id,
      audienceId: audience.id,
      graph: { nodes: [], edges: [] },
    });
    const t = nowIso();

    // Campaign: 3 sent, 1 of them bounced.
    await addRecipient(db, account.id, campaign.id, "delivered", { sentAt: t, deliveredAt: t });
    await addRecipient(db, account.id, campaign.id, "delivered", { sentAt: t, deliveredAt: t });
    await addRecipient(db, account.id, campaign.id, "bounced", { sentAt: t, bouncedAt: t });
    // Automation: 2 sent, 1 complaint.
    await addAutomationSend(db, account.id, automation.id, "s1", "delivered", {
      sentAt: t,
      deliveredAt: t,
    });
    await addAutomationSend(db, account.id, automation.id, "s1", "complained", {
      sentAt: t,
      complainedAt: t,
    });
    // API: one 4-address message, one address bounced.
    await addTransactional(db, account.id, {
      fromEmail: "billing@acme.test",
      to: ["a@example.com", "b@example.com", "c@example.com", "d@example.com"],
      status: "bounced",
      bounced: ["c@example.com"],
    });

    const health = await computeAccountHealth(db, account.id);
    const bySource = Object.fromEntries(health.bySource.map((s) => [s.source, s]));

    expect(bySource.campaign).toMatchObject({ attempted: 3, bounced: 1, complained: 0 });
    expect(bySource.automation).toMatchObject({ attempted: 2, bounced: 0, complained: 1 });
    expect(bySource.api).toMatchObject({ attempted: 4, bounced: 1, complained: 0 });

    // The split IS the headline — that is the whole point of deriving one from
    // the other, so the Metrics page can never show a breakdown that disagrees
    // with the number that pauses the account.
    expect(health.attempted).toBe(9);
    expect(health.bounced).toBe(2);
    expect(health.complained).toBe(1);
  });

  it("reports a zero row for a producer that sent nothing", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const health = await computeAccountHealth(db, account.id);
    expect(health.bySource.map((s) => s.source)).toEqual(["campaign", "automation", "api"]);
    expect(health.bySource.every((s) => s.attempted === 0)).toBe(true);
  });
});
