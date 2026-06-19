import { describe, expect, it } from "vitest";
import { campaignStats } from "../src/api/campaigns";
import { campaignRecipients } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { seedAccount, seedAudience, seedCampaign, seedDomain, testDb } from "./helpers";

describe("campaignStats undeliverable breakdown", () => {
  it("groups skipped (suppressed) vs failed (hard) recipients by reason", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const domain = await seedDomain(db, account.id);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
    });

    const now = nowIso();
    const rows = [
      { status: "sent", error: null, email: "ok1@x.co" },
      { status: "sent", error: null, email: "ok2@x.co" },
      { status: "skipped", error: "suppressed", email: "s1@x.co" },
      { status: "skipped", error: "suppressed", email: "s2@x.co" },
      { status: "failed", error: "550 mailbox not found", email: "f1@x.co" },
    ] as const;
    for (const r of rows) {
      await db.insert(campaignRecipients).values({
        id: newId("rcp"),
        campaignId: campaign.id,
        accountId: account.id,
        email: r.email,
        status: r.status,
        error: r.error,
        createdAt: now,
        updatedAt: now,
      });
    }

    const stats = await campaignStats(db, campaign.id);
    expect(stats.total).toBe(5);
    expect(stats.sent).toBe(2);
    expect(stats.skipped).toBe(2);
    expect(stats.failed).toBe(1);

    const u = stats.undeliverable ?? [];
    // suppressed pair collapses into one grouped row; the hard failure is its own.
    expect(u).toContainEqual({ status: "skipped", reason: "suppressed", count: 2 });
    expect(u).toContainEqual({ status: "failed", reason: "550 mailbox not found", count: 1 });
  });

  it("returns an empty breakdown when nothing was undeliverable", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    const audience = await seedAudience(db, account.id);
    const domain = await seedDomain(db, account.id);
    const campaign = await seedCampaign(db, {
      accountId: account.id,
      audienceId: audience.id,
      sendingDomainId: domain.id,
    });
    const stats = await campaignStats(db, campaign.id);
    expect(stats.undeliverable).toEqual([]);
  });
});
