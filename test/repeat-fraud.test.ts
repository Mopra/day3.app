// The repeat-fraud guard. Modelled on 2026-10-19: "Service Inc" was paused for
// phishing, then "Service spt" came back with a new org, malikweldi27@gmail.com
// instead of malikweldi42@gmail.com, and the same Visa 2709.
import { describe, expect, it } from "vitest";
import type { ClerkClient } from "@clerk/backend";
import { eq } from "drizzle-orm";
import { accountUsers, accounts, jobLogs, paymentCards } from "../src/db/schema";
import { syncCurrentOrganization } from "../src/services/accounts";
import { emailStem, recordPaymentAttempt } from "../src/services/repeat-fraud";
import { seedAccount, testDb } from "./helpers";
import type { Db } from "../src/db/client";
import { newId, nowIso } from "../src/lib/ids";
import { logAdminAction } from "../src/lib/admin-audit";

async function seedPaused(db: Db, email: string, clerkUserId = `user_${newId("u")}`, audited = true) {
  const account = await seedAccount(db, { name: "Service Inc", riskStatus: "paused", sendingEnabled: false });
  const now = nowIso();
  await db.insert(accountUsers).values({
    id: newId("usr"),
    accountId: account.id,
    clerkUserId,
    email,
    role: "admin",
    createdAt: now,
    updatedAt: now,
  });
  if (audited) await logAdminAction(db, adminLog("account.pause", account.id));
  return account;
}

const adminLog = (action: string, targetId: string) => ({
  action,
  actorEmail: "ops@day3.app",
  actorUserId: "user_ops",
  targetType: "account",
  targetId,
});

function fakeClerk(email: string): ClerkClient {
  return {
    organizations: { getOrganization: async () => ({ name: "Service spt", publicMetadata: {} }) },
    users: {
      getUser: async () => ({
        primaryEmailAddressId: "eml_1",
        emailAddresses: [{ id: "eml_1", emailAddress: email }],
      }),
    },
  } as unknown as ClerkClient;
}

const reload = (db: Db, id: string) => db.query.accounts.findFirst({ where: eq(accounts.id, id) });

describe("emailStem", () => {
  it("sees through a changed number, a +tag and Gmail dots", () => {
    expect(emailStem("malikweldi42@gmail.com")).toBe("malikweldi@gmail.com");
    expect(emailStem("Malik.Weldi27+x@googlemail.com")).toBe("malikweldi@gmail.com");
    expect(emailStem("johnnywillis066@gmail.com")).toBe("johnnywillis@gmail.com");
  });

  it("refuses stems too short to identify anyone", () => {
    expect(emailStem("john12@gmail.com")).toBeNull();
    expect(emailStem("not-an-email")).toBeNull();
  });

  it("keeps dots outside Gmail and keeps the domain", () => {
    expect(emailStem("anna.berg@acme.com")).toBe("anna.berg@acme.com");
    expect(emailStem("malikweldi42@outlook.com")).not.toBe(emailStem("malikweldi42@gmail.com"));
  });
});

describe("recordPaymentAttempt", () => {
  it("pauses a workspace that pays with a paused workspace's card", async () => {
    const db = await testDb();
    const bad = await seedPaused(db, "malikweldi42@gmail.com");
    await recordPaymentAttempt(db, { clerkOrgId: bad.clerkOrgId, brand: "Visa", last4: "2709" });
    const comeback = await seedAccount(db, { name: "Service spt" });

    const paused = await recordPaymentAttempt(db, {
      clerkOrgId: comeback.clerkOrgId,
      brand: "visa",
      last4: "2709",
      payerEmail: "someone.else@example.com",
    });

    expect(paused).toBe(true);
    const row = await reload(db, comeback.id);
    expect(row?.riskStatus).toBe("paused");
    expect(row?.sendingEnabled).toBe(false);
    expect(row?.pausedReason).toContain("visa 2709");
    const audit = await db.query.jobLogs.findMany({ where: eq(jobLogs.entityId, comeback.id) });
    expect(audit).toHaveLength(1);
  });

  it("pauses on the payer's address alone", async () => {
    const db = await testDb();
    await seedPaused(db, "malikweldi42@gmail.com");
    const comeback = await seedAccount(db);

    expect(
      await recordPaymentAttempt(db, {
        clerkOrgId: comeback.clerkOrgId,
        brand: "mastercard",
        last4: "1111",
        payerEmail: "malikweldi27@gmail.com",
      }),
    ).toBe(true);
  });

  it("leaves an honest workspace alone and only records its card", async () => {
    const db = await testDb();
    const bad = await seedPaused(db, "malikweldi42@gmail.com");
    await recordPaymentAttempt(db, { clerkOrgId: bad.clerkOrgId, brand: "visa", last4: "2709" });
    const honest = await seedAccount(db);

    expect(
      await recordPaymentAttempt(db, {
        clerkOrgId: honest.clerkOrgId,
        brand: "visa",
        last4: "4242",
        payerEmail: "owner@acme.com",
      }),
    ).toBe(false);
    expect((await reload(db, honest.id))?.riskStatus).toBe("normal");
    expect(await db.select().from(paymentCards).where(eq(paymentCards.clerkOrgId, honest.clerkOrgId))).toHaveLength(1);
  });

  it("ignores a workspace paused for bounces, which has no audit row", async () => {
    const db = await testDb();
    const bounced = await seedPaused(db, "malikweldi42@gmail.com", undefined, false);
    await recordPaymentAttempt(db, { clerkOrgId: bounced.clerkOrgId, brand: "visa", last4: "2709" });
    const second = await seedAccount(db);
    expect(
      await recordPaymentAttempt(db, {
        clerkOrgId: second.clerkOrgId,
        brand: "visa",
        last4: "2709",
        payerEmail: "malikweldi27@gmail.com",
      }),
    ).toBe(false);
  });

  it("does not pause again once an operator resumed the workspace", async () => {
    const db = await testDb();
    const bad = await seedPaused(db, "someone@example.com");
    await recordPaymentAttempt(db, { clerkOrgId: bad.clerkOrgId, brand: "visa", last4: "2709" });
    const shared = await seedAccount(db);
    expect(await recordPaymentAttempt(db, { clerkOrgId: shared.clerkOrgId, brand: "visa", last4: "2709" })).toBe(true);

    await db.update(accounts).set({ riskStatus: "normal", sendingEnabled: true }).where(eq(accounts.id, shared.id));
    await logAdminAction(db, adminLog("account.resume", shared.id));

    expect(await recordPaymentAttempt(db, { clerkOrgId: shared.clerkOrgId, brand: "visa", last4: "2709" })).toBe(false);
    expect((await reload(db, shared.id))?.riskStatus).toBe("normal");
  });

  it("does not match a card held only by a normal workspace", async () => {
    const db = await testDb();
    const first = await seedAccount(db);
    await recordPaymentAttempt(db, { clerkOrgId: first.clerkOrgId, brand: "visa", last4: "2709" });
    const second = await seedAccount(db);
    expect(await recordPaymentAttempt(db, { clerkOrgId: second.clerkOrgId, brand: "visa", last4: "2709" })).toBe(false);
  });

  it("records a card that arrives before the account exists, and creation catches it", async () => {
    const db = await testDb();
    const bad = await seedPaused(db, "someone@example.com");
    await recordPaymentAttempt(db, { clerkOrgId: bad.clerkOrgId, brand: "visa", last4: "2709" });
    expect(await recordPaymentAttempt(db, { clerkOrgId: "org_early", brand: "visa", last4: "2709" })).toBe(false);

    const account = await syncCurrentOrganization(db, fakeClerk("fresh.person@example.org"), {
      userId: "user_new",
      orgId: "org_early",
      has: () => false,
    });
    expect(account.riskStatus).toBe("paused");
  });
});

describe("new workspace check", () => {
  it("pauses a new workspace whose owner's address matches a paused one", async () => {
    const db = await testDb();
    await seedPaused(db, "malikweldi42@gmail.com");
    const account = await syncCurrentOrganization(db, fakeClerk("malikweldi27@gmail.com"), {
      userId: "user_new",
      orgId: "org_spt",
      has: () => false,
    });
    expect(account.riskStatus).toBe("paused");
    expect(account.sendingEnabled).toBe(false);
  });

  it("pauses a new workspace made by a member of a paused one", async () => {
    const db = await testDb();
    await seedPaused(db, "a@x.io", "user_same");
    const account = await syncCurrentOrganization(db, fakeClerk("totally.different@example.org"), {
      userId: "user_same",
      orgId: "org_again",
      has: () => false,
    });
    expect(account.riskStatus).toBe("paused");
  });

  it("lets an unrelated owner through", async () => {
    const db = await testDb();
    await seedPaused(db, "malikweldi42@gmail.com");
    const account = await syncCurrentOrganization(db, fakeClerk("owner@acme.com"), {
      userId: "user_new",
      orgId: "org_acme",
      has: () => false,
    });
    expect(account.riskStatus).toBe("normal");
  });
});
