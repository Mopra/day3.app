import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { resetMonthlyUsage } from "../src/queue/cron";
import { applySubscriptionEvent } from "../src/services/accounts";
import { accounts } from "../src/db/schema";
import { testDb, seedAccount } from "./helpers";

const iso = (ms: number) => new Date(ms).toISOString();

describe("resetMonthlyUsage (cron fallback)", () => {
  it("zeroes only the account whose period has elapsed", async () => {
    const db = await testDb();
    const now = new Date("2026-06-01T03:05:00.000Z");

    // Period already ended (yesterday) — should reset.
    const elapsed = await seedAccount(db, {
      monthlyEmailSentCount: 500,
      currentPeriodStart: iso(now.getTime() - 31 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: iso(now.getTime() - 24 * 60 * 60 * 1000),
    });
    // Period started mid-month, still running — must NOT reset.
    const active = await seedAccount(db, {
      monthlyEmailSentCount: 300,
      currentPeriodStart: iso(now.getTime() - 5 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: iso(now.getTime() + 25 * 24 * 60 * 60 * 1000),
    });

    const count = await resetMonthlyUsage(db, now);

    expect(count).toBe(1);
    const elapsedRow = await db.query.accounts.findFirst({ where: eq(accounts.id, elapsed.id) });
    const activeRow = await db.query.accounts.findFirst({ where: eq(accounts.id, active.id) });
    expect(elapsedRow?.monthlyEmailSentCount).toBe(0);
    expect(activeRow?.monthlyEmailSentCount).toBe(300);
  });

  it("resets accounts that never received a billing webhook (null period)", async () => {
    const db = await testDb();
    const now = new Date("2026-06-01T03:05:00.000Z");
    const acc = await seedAccount(db, {
      monthlyEmailSentCount: 42,
      currentPeriodStart: null,
      currentPeriodEnd: null,
    });

    const count = await resetMonthlyUsage(db, now);

    expect(count).toBe(1);
    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, acc.id) });
    expect(row?.monthlyEmailSentCount).toBe(0);
    // Marker advanced so the next run cannot reset the same period again.
    expect(row?.currentPeriodEnd).not.toBeNull();
  });

  it("does not reset the same elapsed period twice", async () => {
    const db = await testDb();
    const now = new Date("2026-06-01T03:05:00.000Z");
    const acc = await seedAccount(db, {
      monthlyEmailSentCount: 99,
      currentPeriodStart: iso(now.getTime() - 31 * 24 * 60 * 60 * 1000),
      currentPeriodEnd: iso(now.getTime() - 24 * 60 * 60 * 1000),
    });

    const first = await resetMonthlyUsage(db, now);
    expect(first).toBe(1);

    // Account sends more this fresh period.
    await db
      .update(accounts)
      .set({ monthlyEmailSentCount: 7 })
      .where(eq(accounts.id, acc.id));

    // A second run a few minutes later (same period) must be a no-op for it.
    const second = await resetMonthlyUsage(db, new Date(now.getTime() + 10 * 60 * 1000));
    expect(second).toBe(0);
    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, acc.id) });
    expect(row?.monthlyEmailSentCount).toBe(7);
  });
});

describe("applySubscriptionEvent (primary period source)", () => {
  it("zeroes usage when Clerk reports a new period start", async () => {
    const db = await testDb();
    const acc = await seedAccount(db, {
      clerkOrgId: "org_primary",
      monthlyEmailSentCount: 250,
      currentPeriodStart: "2026-05-01T00:00:00.000Z",
      currentPeriodEnd: "2026-06-01T00:00:00.000Z",
    });

    await applySubscriptionEvent(db, {
      clerkOrgId: "org_primary",
      planSlug: "10k_plan",
      lifecycle: "active",
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
    });

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, acc.id) });
    expect(row?.monthlyEmailSentCount).toBe(0);
    expect(Date.parse(row!.currentPeriodStart!)).toBe(Date.parse("2026-06-01T00:00:00.000Z"));
  });

  it("does not reset usage on a redelivered webhook for the same period", async () => {
    const db = await testDb();
    const acc = await seedAccount(db, {
      clerkOrgId: "org_redelivery",
      monthlyEmailSentCount: 120,
      currentPeriodStart: "2026-06-01T00:00:00.000Z",
      currentPeriodEnd: "2026-07-01T00:00:00.000Z",
    });

    await applySubscriptionEvent(db, {
      clerkOrgId: "org_redelivery",
      planSlug: "10k_plan",
      lifecycle: "active",
      periodStart: "2026-06-01T00:00:00.000Z",
      periodEnd: "2026-07-01T00:00:00.000Z",
    });

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, acc.id) });
    expect(row?.monthlyEmailSentCount).toBe(120);
  });
});

describe("applySubscriptionEvent lifecycle (deterministic + idempotent)", () => {
  const period = {
    periodStart: "2026-06-01T00:00:00.000Z",
    periodEnd: "2026-07-01T00:00:00.000Z",
  };

  it("active -> past_due -> active maps statuses deterministically and is idempotent", async () => {
    const db = await testDb();
    const acc = await seedAccount(db, {
      clerkOrgId: "org_lifecycle",
      plan: "10k_plan",
      subscriptionStatus: "active",
      sendingEnabled: true,
      monthlyEmailLimit: 10_000,
      monthlyEmailSentCount: 4000,
      currentPeriodStart: period.periodStart,
      currentPeriodEnd: period.periodEnd,
    });

    const read = async () =>
      (await db.query.accounts.findFirst({ where: eq(accounts.id, acc.id) }))!;

    // Payment fails: past_due blocks sending but keeps the plan/limit and usage.
    await applySubscriptionEvent(db, {
      clerkOrgId: "org_lifecycle",
      planSlug: "10k_plan",
      lifecycle: "past_due",
      ...period,
    });
    let row = await read();
    expect(row.subscriptionStatus).toBe("past_due");
    expect(row.sendingEnabled).toBe(false);
    expect(row.plan).toBe("10k_plan");
    expect(row.monthlyEmailLimit).toBe(10_000);
    expect(row.monthlyEmailSentCount).toBe(4000);

    // Duplicate past_due redelivery is a no-op (same row).
    await applySubscriptionEvent(db, {
      clerkOrgId: "org_lifecycle",
      planSlug: "10k_plan",
      lifecycle: "past_due",
      ...period,
    });
    row = await read();
    expect(row.subscriptionStatus).toBe("past_due");
    expect(row.monthlyEmailSentCount).toBe(4000);

    // Payment recovers within the same period: re-activates without zeroing usage.
    await applySubscriptionEvent(db, {
      clerkOrgId: "org_lifecycle",
      planSlug: "10k_plan",
      lifecycle: "active",
      ...period,
    });
    row = await read();
    expect(row.subscriptionStatus).toBe("active");
    expect(row.sendingEnabled).toBe(true);
    expect(row.monthlyEmailSentCount).toBe(4000);
  });

  it("tolerates an out-of-order active redelivery for an already-elapsed period", async () => {
    const db = await testDb();
    const acc = await seedAccount(db, {
      clerkOrgId: "org_ooo",
      plan: "10k_plan",
      subscriptionStatus: "active",
      sendingEnabled: true,
      monthlyEmailSentCount: 50,
      currentPeriodStart: "2026-06-01T00:00:00.000Z",
      currentPeriodEnd: "2026-07-01T00:00:00.000Z",
    });

    // A stale "active" for the previous period arrives late. Its period start is
    // not newer, so it must not zero the current usage.
    await applySubscriptionEvent(db, {
      clerkOrgId: "org_ooo",
      planSlug: "10k_plan",
      lifecycle: "active",
      periodStart: "2026-05-01T00:00:00.000Z",
      periodEnd: "2026-06-01T00:00:00.000Z",
    });

    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, acc.id) });
    expect(row?.monthlyEmailSentCount).toBe(50);
  });

  it("ended gracefully downgrades to the active free tier without zeroing usage", async () => {
    const db = await testDb();
    const acc = await seedAccount(db, {
      clerkOrgId: "org_ended",
      plan: "10k_plan",
      subscriptionStatus: "active",
      sendingEnabled: true,
      monthlyEmailSentCount: 7,
      ...period,
    });

    await applySubscriptionEvent(db, {
      clerkOrgId: "org_ended",
      planSlug: "10k_plan",
      lifecycle: "ended",
      ...period,
    });

    // A lapsed subscription drops to the always-active free tier (set-up + drafts,
    // no sending), not a locked-out "inactive" state. Usage is preserved.
    const row = await db.query.accounts.findFirst({ where: eq(accounts.id, acc.id) });
    expect(row?.subscriptionStatus).toBe("active");
    expect(row?.sendingEnabled).toBe(false);
    expect(row?.plan).toBe("free_org");
    expect(row?.monthlyEmailLimit).toBe(0);
    expect(row?.monthlyEmailSentCount).toBe(7);
  });
});
