import { describe, expect, it } from "vitest";
import { listAccountActivity } from "../src/services/activity";
import { emailEvents, type EmailEventType } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import type { Db } from "../src/db/client";
import { seedAccount, seedAudience, seedCampaign, seedDomain, testDb } from "./helpers";

async function addEvent(
  db: Db,
  accountId: string,
  campaignId: string | null,
  eventType: EmailEventType,
  overrides: Partial<typeof emailEvents.$inferInsert> = {},
): Promise<string> {
  const id = newId("evt");
  await db.insert(emailEvents).values({
    id,
    accountId,
    campaignId,
    eventType,
    email: "alice@example.com",
    provider: "ses",
    createdAt: nowIso(),
    ...overrides,
  });
  return id;
}

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

describe("listAccountActivity", () => {
  it("returns events newest-first with the campaign name joined in", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const campaign = await seedCampaignFor(db, account.id);

    await addEvent(db, account.id, campaign.id, "sent", {
      createdAt: "2026-07-01T10:00:00.000Z",
    });
    await addEvent(db, account.id, campaign.id, "delivery", {
      createdAt: "2026-07-01T10:05:00.000Z",
    });

    const { events, total } = await listAccountActivity(db, account.id, {
      limit: 50,
      offset: 0,
    });
    expect(total).toBe(2);
    expect(events.map((e) => e.eventType)).toEqual(["delivery", "sent"]);
    expect(events[0].campaignName).toBe(campaign.name);
  });

  it("never leaks events across accounts", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const other = await seedAccount(db);
    const campaign = await seedCampaignFor(db, account.id);
    const otherCampaign = await seedCampaignFor(db, other.id);

    await addEvent(db, account.id, campaign.id, "sent");
    await addEvent(db, other.id, otherCampaign.id, "sent");

    const { events, total } = await listAccountActivity(db, account.id, {
      limit: 50,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(events[0].campaignId).toBe(campaign.id);
  });

  it("filters by event type, campaign and email substring", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const a = await seedCampaignFor(db, account.id);
    const b = await seedCampaignFor(db, account.id);

    await addEvent(db, account.id, a.id, "sent", { email: "alice@example.com" });
    await addEvent(db, account.id, a.id, "bounce", { email: "bob@example.com" });
    await addEvent(db, account.id, b.id, "sent", { email: "carol@other.io" });

    const byType = await listAccountActivity(db, account.id, {
      eventType: "bounce",
      limit: 50,
      offset: 0,
    });
    expect(byType.total).toBe(1);
    expect(byType.events[0].email).toBe("bob@example.com");

    const byCampaign = await listAccountActivity(db, account.id, {
      campaignId: b.id,
      limit: 50,
      offset: 0,
    });
    expect(byCampaign.total).toBe(1);
    expect(byCampaign.events[0].email).toBe("carol@other.io");

    // Case-insensitive substring on the recipient email.
    const bySearch = await listAccountActivity(db, account.id, {
      search: "ALICE",
      limit: 50,
      offset: 0,
    });
    expect(bySearch.total).toBe(1);
    expect(bySearch.events[0].email).toBe("alice@example.com");

    const combined = await listAccountActivity(db, account.id, {
      eventType: "sent",
      campaignId: a.id,
      limit: 50,
      offset: 0,
    });
    expect(combined.total).toBe(1);
    expect(combined.events[0].email).toBe("alice@example.com");
  });

  it("paginates with a stable order and reports the filtered total", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const campaign = await seedCampaignFor(db, account.id);

    // Same timestamp for all rows — the id tie-break must keep pages disjoint.
    const t = nowIso();
    for (let i = 0; i < 5; i++) {
      await addEvent(db, account.id, campaign.id, "sent", { createdAt: t });
    }

    const page1 = await listAccountActivity(db, account.id, { limit: 2, offset: 0 });
    const page2 = await listAccountActivity(db, account.id, { limit: 2, offset: 2 });
    const page3 = await listAccountActivity(db, account.id, { limit: 2, offset: 4 });

    expect(page1.total).toBe(5);
    const ids = [...page1.events, ...page2.events, ...page3.events].map((e) => e.id);
    expect(ids).toHaveLength(5);
    expect(new Set(ids).size).toBe(5);
  });

  it("returns an event with no campaign (campaignName null) rather than dropping it", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await addEvent(db, account.id, null, "unsubscribe");

    const { events, total } = await listAccountActivity(db, account.id, {
      limit: 50,
      offset: 0,
    });
    expect(total).toBe(1);
    expect(events[0].campaignId).toBeNull();
    expect(events[0].campaignName).toBeNull();
  });
});
