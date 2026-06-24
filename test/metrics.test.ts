import { describe, expect, it } from "vitest";
import { accountCampaignMetrics } from "../src/services/metrics";
import { campaignRecipients, type RecipientStatus } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import type { Db } from "../src/db/client";
import { seedAccount, seedAudience, seedCampaign, seedDomain, testDb } from "./helpers";

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
