import { describe, expect, it } from "vitest";
import {
  hasRecentNotification,
  listNotifications,
  markAllNotificationsRead,
  notifyAccount,
  notifyAccountThrottled,
  notifyCampaignSent,
} from "../src/services/notifications";
import { campaignRecipients } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import {
  seedAccount,
  seedAudience,
  seedCampaign,
  seedDomain,
  testDb,
} from "./helpers";

// EMAIL_PROVIDER defaults to "mock" in tests (logs, never sends), and a fresh
// account has no account_users, so notifyAccount takes the no-recipient path —
// these tests exercise the durable in-app record, which is the point.
describe("notifications service", () => {
  it("persists an in-app notification row", async () => {
    const db = await testDb();
    const account = await seedAccount(db);

    await notifyAccount(db, account, {
      kind: "import_completed",
      title: "Import complete",
      body: "500 subscribers added.",
      ctaHref: "/audiences/aud_1",
      ctaLabel: "View",
    });

    const rows = await listNotifications(db, account.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("Import complete");
    expect(rows[0].kind).toBe("import_completed");
    expect(rows[0].readAt).toBeNull();
  });

  it("throttles repeat notifications of the same kind within the window", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const input = {
      kind: "subscribers_cap_reached" as const,
      title: "At the free limit",
      body: "Signups are being turned away.",
    };

    await notifyAccountThrottled(db, account, input, 24);
    await notifyAccountThrottled(db, account, input, 24);

    // Only the first one lands.
    expect(await listNotifications(db, account.id)).toHaveLength(1);
    expect(await hasRecentNotification(db, account.id, "subscribers_cap_reached", 24)).toBe(true);
    expect(await hasRecentNotification(db, account.id, "campaign_sent", 24)).toBe(false);
  });

  it("marks all notifications read", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await notifyAccount(db, account, { kind: "campaign_sent", title: "A", body: "b" });
    await notifyAccount(db, account, { kind: "import_completed", title: "B", body: "c" });

    await markAllNotificationsRead(db, account.id);

    const rows = await listNotifications(db, account.id);
    expect(rows.every((r) => r.readAt !== null)).toBe(true);
  });

  it("notifyCampaignSent reports the reached recipient count", async () => {
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
    // Two delivered/sent recipients + one failed (not counted).
    const now = nowIso();
    await db.insert(campaignRecipients).values(
      ["sent", "delivered", "failed"].map((status, i) => ({
        id: newId("rcp"),
        campaignId: campaign.id,
        accountId: account.id,
        email: `r${i}@example.com`,
        status: status as "sent" | "delivered" | "failed",
        createdAt: now,
        updatedAt: now,
      })),
    );

    await notifyCampaignSent(db, campaign);

    const [row] = await listNotifications(db, account.id);
    expect(row.kind).toBe("campaign_sent");
    expect(row.body).toContain("2 subscribers");
    expect(row.ctaHref).toBe(`/campaigns/${campaign.id}`);
  });
});
