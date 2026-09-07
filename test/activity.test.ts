import { describe, expect, it } from "vitest";
import { getActivitySend, listAccountActivity } from "../src/services/activity";
import {
  campaignRecipients,
  emailEvents,
  transactionalEmails,
  type RecipientStatus,
  type TransactionalEmailStatus,
} from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import type { Db } from "../src/db/client";
import { seedAccount, seedAudience, seedCampaign, seedDomain, testDb } from "./helpers";

// One audience + domain per account (the domain has a unique (account, domain)
// constraint), reused for however many campaigns a test needs.
async function seedCampaignFor(db: Db, accountId: string) {
  const audience = await seedAudience(db, accountId);
  const domain = await seedDomain(db, accountId, { domain: `${newId("d")}.test.co` });
  return seedCampaign(db, {
    accountId,
    audienceId: audience.id,
    sendingDomainId: domain.id,
    status: "sent",
  });
}

async function addRecipient(
  db: Db,
  accountId: string,
  campaignId: string,
  email: string,
  status: RecipientStatus,
  overrides: Partial<typeof campaignRecipients.$inferInsert> = {},
): Promise<string> {
  const id = newId("rcp");
  const now = nowIso();
  await db.insert(campaignRecipients).values({
    id,
    accountId,
    campaignId,
    email,
    status,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

async function addTransactional(
  db: Db,
  accountId: string,
  to: string[],
  status: TransactionalEmailStatus,
  overrides: Partial<typeof transactionalEmails.$inferInsert> = {},
): Promise<string> {
  const id = newId("eml");
  const now = nowIso();
  await db.insert(transactionalEmails).values({
    id,
    accountId,
    fromEmail: "app@updates.test.co",
    to,
    subject: "Reset your password",
    textBody: "Click here",
    status,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

describe("listAccountActivity", () => {
  it("unions campaign and API sends newest-first onto one shape", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const campaign = await seedCampaignFor(db, account.id);

    await addRecipient(db, account.id, campaign.id, "alice@example.com", "delivered", {
      createdAt: "2026-07-01T10:00:00.000Z",
    });
    await addTransactional(db, account.id, ["bob@example.com", "carol@example.com"], "sent", {
      createdAt: "2026-07-01T10:05:00.000Z",
    });

    const { sends, total } = await listAccountActivity(db, account.id, { limit: 50, offset: 0 });
    expect(total).toBe(2);
    expect(sends.map((s) => s.source)).toEqual(["api", "campaign"]);
    expect(sends[0].email).toBe("bob@example.com");
    expect(sends[0].recipientCount).toBe(2);
    expect(sends[0].subject).toBe("Reset your password");
    expect(sends[1].campaignName).toBe(campaign.name);
    expect(sends[1].status).toBe("delivered");
  });

  it("never leaks sends across accounts", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const other = await seedAccount(db);
    const campaign = await seedCampaignFor(db, account.id);
    const otherCampaign = await seedCampaignFor(db, other.id);

    await addRecipient(db, account.id, campaign.id, "alice@example.com", "sent");
    await addRecipient(db, other.id, otherCampaign.id, "mallory@example.com", "sent");
    await addTransactional(db, other.id, ["mallory@example.com"], "sent");

    const { sends, total } = await listAccountActivity(db, account.id, { limit: 50, offset: 0 });
    expect(total).toBe(1);
    expect(sends[0].campaignId).toBe(campaign.id);
  });

  it("filters by source, status, campaign and recipient substring", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const a = await seedCampaignFor(db, account.id);
    const b = await seedCampaignFor(db, account.id);

    await addRecipient(db, account.id, a.id, "alice@example.com", "sent");
    await addRecipient(db, account.id, a.id, "bob@example.com", "bounced");
    await addRecipient(db, account.id, b.id, "carol@other.io", "pending");
    await addTransactional(db, account.id, ["dana@example.com"], "bounced");
    await addTransactional(db, account.id, ["erik@example.com"], "sending");

    const api = await listAccountActivity(db, account.id, { source: "api", limit: 50, offset: 0 });
    expect(api.total).toBe(2);
    expect(api.sends.every((s) => s.source === "api")).toBe(true);

    const campaignsOnly = await listAccountActivity(db, account.id, {
      source: "campaign",
      limit: 50,
      offset: 0,
    });
    expect(campaignsOnly.total).toBe(3);

    // A shared status spans both ledgers.
    const bounced = await listAccountActivity(db, account.id, {
      status: "bounced",
      limit: 50,
      offset: 0,
    });
    expect(bounced.total).toBe(2);
    expect(bounced.sends.map((s) => s.email).sort()).toEqual(["bob@example.com", "dana@example.com"]);

    // "queued" normalises pending (campaign) and sending (API) alike.
    const queued = await listAccountActivity(db, account.id, {
      status: "queued",
      limit: 50,
      offset: 0,
    });
    expect(queued.total).toBe(2);
    expect(queued.sends.every((s) => s.status === "queued")).toBe(true);

    const byCampaign = await listAccountActivity(db, account.id, {
      campaignId: b.id,
      limit: 50,
      offset: 0,
    });
    expect(byCampaign.total).toBe(1);
    expect(byCampaign.sends[0].email).toBe("carol@other.io");

    // Case-insensitive substring on the recipient, across both ledgers.
    const bySearch = await listAccountActivity(db, account.id, {
      search: "EXAMPLE.COM",
      limit: 50,
      offset: 0,
    });
    expect(bySearch.total).toBe(4);

    // A LIKE metacharacter is matched literally rather than widening the scan.
    const literal = await listAccountActivity(db, account.id, {
      search: "%",
      limit: 50,
      offset: 0,
    });
    expect(literal.total).toBe(0);
  });

  it("treats opened/clicked as engagement filters on campaign rows", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const campaign = await seedCampaignFor(db, account.id);
    await addRecipient(db, account.id, campaign.id, "alice@example.com", "delivered", {
      openedAt: nowIso(),
    });
    await addRecipient(db, account.id, campaign.id, "bob@example.com", "delivered");
    await addTransactional(db, account.id, ["carol@example.com"], "delivered");

    const opened = await listAccountActivity(db, account.id, {
      status: "opened",
      limit: 50,
      offset: 0,
    });
    expect(opened.total).toBe(1);
    expect(opened.sends[0].email).toBe("alice@example.com");
  });

  it("paginates with a stable order across both ledgers and reports the total", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const campaign = await seedCampaignFor(db, account.id);

    // Same timestamp for all rows: the id tie-break must keep pages disjoint.
    const t = nowIso();
    for (let i = 0; i < 3; i++) {
      await addRecipient(db, account.id, campaign.id, `r${i}@example.com`, "sent", { createdAt: t });
      await addTransactional(db, account.id, [`t${i}@example.com`], "sent", { createdAt: t });
    }

    const pages = await Promise.all(
      [0, 2, 4].map((offset) => listAccountActivity(db, account.id, { limit: 2, offset })),
    );
    expect(pages[0].total).toBe(6);
    const ids = pages.flatMap((p) => p.sends.map((s) => s.id));
    expect(ids).toHaveLength(6);
    expect(new Set(ids).size).toBe(6);
  });
});

describe("getActivitySend", () => {
  it("returns a campaign send with its own events only", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const campaign = await seedCampaignFor(db, account.id);
    const id = await addRecipient(db, account.id, campaign.id, "alice@example.com", "bounced");
    const otherId = await addRecipient(db, account.id, campaign.id, "bob@example.com", "sent");
    for (const [recipientId, eventType] of [
      [id, "sent"],
      [id, "bounce"],
      [otherId, "sent"],
    ] as const) {
      await db.insert(emailEvents).values({
        id: newId("evt"),
        accountId: account.id,
        campaignId: campaign.id,
        campaignRecipientId: recipientId,
        eventType,
        email: "alice@example.com",
        createdAt: nowIso(),
      });
    }

    const result = await getActivitySend(db, account.id, "campaign", id);
    expect(result).not.toBeNull();
    expect(result!.send.status).toBe("bounced");
    expect(result!.send.campaignName).toBe(campaign.name);
    expect(result!.events.map((e) => e.eventType)).toEqual(["sent", "bounce"]);
    expect(result!.email).toBeNull();

    // The wrong ledger, or another account, finds nothing.
    expect(await getActivitySend(db, account.id, "api", id)).toBeNull();
    expect(await getActivitySend(db, account.id, "automation", id)).toBeNull();
    const other = await seedAccount(db);
    expect(await getActivitySend(db, other.id, "campaign", id)).toBeNull();
  });

  it("returns an API send with its content and timeline", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const id = await addTransactional(db, account.id, ["dana@example.com"], "delivered");
    await db.insert(emailEvents).values({
      id: newId("evt"),
      accountId: account.id,
      transactionalEmailId: id,
      eventType: "delivery",
      email: "dana@example.com",
      createdAt: nowIso(),
    });

    const result = await getActivitySend(db, account.id, "api", id);
    expect(result!.send.source).toBe("api");
    expect(result!.send.subject).toBe("Reset your password");
    expect(result!.email?.textBody).toBe("Click here");
    expect(result!.events.map((e) => e.eventType)).toEqual(["delivery"]);
  });
});
