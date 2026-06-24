import { describe, expect, it } from "vitest";
import type { ClerkClient } from "@clerk/backend";
import { accountUsers, accounts } from "../src/db/schema";
import {
  reconcileMembershipByOrg,
  removeAllMemberships,
  removeMembership,
  roleFromClerk,
  syncCurrentOrganization,
} from "../src/services/accounts";
import { testDb, seedAccount } from "./helpers";

// Minimal Clerk stub covering only what syncCurrentOrganization touches.
function fakeClerk(opts: {
  orgName?: string;
  email: string;
  role: string;
  publicMetadata?: Record<string, unknown>;
}): ClerkClient {
  const stub = {
    organizations: {
      getOrganization: async () => ({
        name: opts.orgName ?? "Acme Inc",
        publicMetadata: opts.publicMetadata ?? {},
      }),
      getOrganizationMembershipList: async () => ({
        data: [{ role: opts.role }],
        totalCount: 1,
      }),
    },
    users: {
      getUser: async () => ({
        primaryEmailAddressId: "eml_1",
        emailAddresses: [{ id: "eml_1", emailAddress: opts.email }],
      }),
    },
  };
  return stub as unknown as ClerkClient;
}

const auth = (orgId: string, userId = "user_1") => ({
  userId,
  orgId,
  has: () => false,
});

describe("syncCurrentOrganization", () => {
  it("creates the account and records the member with the org role", async () => {
    const db = await testDb();
    const clerk = fakeClerk({ email: "Owner@Acme.com", role: "org:admin" });

    const account = await syncCurrentOrganization(db, clerk, auth("org_new"));

    expect(account.clerkOrgId).toBe("org_new");
    const members = await db.query.accountUsers.findMany({
      where: (t, { eq: e }) => e(t.accountId, account.id),
    });
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("admin");
    expect(members[0].email).toBe("owner@acme.com");
  });

  it("two concurrent first loads resolve to one account with no error", async () => {
    const db = await testDb();
    const clerk = fakeClerk({ email: "a@acme.com", role: "org:member" });

    const [a, b] = await Promise.all([
      syncCurrentOrganization(db, clerk, auth("org_race")),
      syncCurrentOrganization(db, clerk, auth("org_race")),
    ]);

    expect(a.id).toBe(b.id);
    const rows = await db.query.accounts.findMany({
      where: (t, { eq: e }) => e(t.clerkOrgId, "org_race"),
    });
    expect(rows).toHaveLength(1);

    // The membership upsert must also converge to a single row.
    const members = await db.query.accountUsers.findMany({
      where: (t, { eq: e }) => e(t.accountId, a.id),
    });
    expect(members).toHaveLength(1);
  });

  it("never re-activates a stored past_due row from an active session claim", async () => {
    // Clerk keeps the plan entitlement assigned during the past_due grace window,
    // so the session reports hasPaidPlan=true. A dashboard/billing reload must NOT
    // flip the stored past_due row back to active and re-enable sending — that is
    // deferred to the authoritative subscriptionItem.active webhook.
    const db = await testDb();
    const account = await seedAccount(db, {
      clerkOrgId: "org_pastdue",
      plan: "10k_plan",
      subscriptionStatus: "past_due",
      sendingEnabled: false,
    });

    const result = await syncCurrentOrganization(db, fakeClerk({ email: "a@acme.com", role: "org:admin" }), {
      userId: "user_1",
      orgId: "org_pastdue",
      has: () => true, // active plan entitlement still assigned during dunning
    });

    expect(result.subscriptionStatus).toBe("past_due");
    expect(result.sendingEnabled).toBe(false);

    const stored = await db.query.accounts.findFirst({
      where: (t, { eq: e }) => e(t.id, account.id),
    });
    expect(stored?.subscriptionStatus).toBe("past_due");
    expect(stored?.sendingEnabled).toBe(false);
  });

  it("forces the tier from a publicMetadata override, enabling sending without a subscription", async () => {
    const db = await testDb();
    // No paid entitlement on the session (has() === false), but the org's public
    // metadata pins it to the 25k tier — the tester override.
    const clerk = fakeClerk({
      email: "tester@acme.com",
      role: "org:admin",
      publicMetadata: { plan: "25k_plan" },
    });

    const account = await syncCurrentOrganization(db, clerk, auth("org_override"));

    expect(account.plan).toBe("25k_plan");
    expect(account.sendingEnabled).toBe(true);
    expect(account.monthlyEmailLimit).toBe(25_000);
    expect(account.subscriptionStatus).toBe("active");
  });

  it("override wins over a stored past_due hold", async () => {
    const db = await testDb();
    await seedAccount(db, {
      clerkOrgId: "org_override_pastdue",
      plan: "10k_plan",
      subscriptionStatus: "past_due",
      sendingEnabled: false,
    });

    const result = await syncCurrentOrganization(
      db,
      fakeClerk({ email: "a@acme.com", role: "org:admin", publicMetadata: { plan: "50k_plan" } }),
      { userId: "user_1", orgId: "org_override_pastdue", has: () => true },
    );

    expect(result.plan).toBe("50k_plan");
    expect(result.subscriptionStatus).toBe("active");
    expect(result.sendingEnabled).toBe(true);
  });

  it("ignores an unrecognized override value and falls back to real billing", async () => {
    const db = await testDb();
    const clerk = fakeClerk({
      email: "a@acme.com",
      role: "org:admin",
      publicMetadata: { plan: "not_a_real_plan" },
    });

    const account = await syncCurrentOrganization(db, clerk, auth("org_bad_override"));

    expect(account.plan).toBe("free_org");
    expect(account.sendingEnabled).toBe(false);
  });

  it("reconciles a changed role on a later sync", async () => {
    const db = await testDb();

    const acc = await syncCurrentOrganization(
      db,
      fakeClerk({ email: "a@acme.com", role: "org:member" }),
      auth("org_promote"),
    );
    let members = await db.query.accountUsers.findMany({
      where: (t, { eq: e }) => e(t.accountId, acc.id),
    });
    expect(members[0].role).toBe("member");

    await syncCurrentOrganization(
      db,
      fakeClerk({ email: "a@acme.com", role: "org:admin" }),
      auth("org_promote"),
    );
    members = await db.query.accountUsers.findMany({
      where: (t, { eq: e }) => e(t.accountId, acc.id),
    });
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("admin");
  });
});

describe("membership webhook reconcilers", () => {
  it("upserts and removes a single membership", async () => {
    const db = await testDb();
    const account = await seedAccount(db, { clerkOrgId: "org_wh" });

    await reconcileMembershipByOrg(db, {
      clerkOrgId: "org_wh",
      clerkUserId: "user_2",
      email: "B@acme.com",
      role: "admin",
    });
    let members = await db.query.accountUsers.findMany({
      where: (t, { eq: e }) => e(t.accountId, account.id),
    });
    expect(members).toHaveLength(1);
    expect(members[0].role).toBe("admin");

    await removeMembership(db, "org_wh", "user_2");
    members = await db.query.accountUsers.findMany({
      where: (t, { eq: e }) => e(t.accountId, account.id),
    });
    expect(members).toHaveLength(0);
  });

  it("removes all memberships when the org is deleted", async () => {
    const db = await testDb();
    const account = await seedAccount(db, { clerkOrgId: "org_del" });
    for (const uid of ["user_a", "user_b"]) {
      await reconcileMembershipByOrg(db, {
        clerkOrgId: "org_del",
        clerkUserId: uid,
        email: `${uid}@acme.com`,
        role: "member",
      });
    }
    expect(
      await db.query.accountUsers.findMany({
        where: (t, { eq: e }) => e(t.accountId, account.id),
      }),
    ).toHaveLength(2);

    await removeAllMemberships(db, "org_del");
    expect(
      await db.query.accountUsers.findMany({
        where: (t, { eq: e }) => e(t.accountId, account.id),
      }),
    ).toHaveLength(0);
  });

  it("is a no-op for an org with no local account", async () => {
    const db = await testDb();
    await reconcileMembershipByOrg(db, {
      clerkOrgId: "org_missing",
      clerkUserId: "user_x",
      email: "x@acme.com",
      role: "member",
    });
    await removeMembership(db, "org_missing", "user_x");
    await removeAllMemberships(db, "org_missing");
    expect(await db.select().from(accountUsers)).toHaveLength(0);
    expect(await db.select().from(accounts)).toHaveLength(0);
  });

  it("roleFromClerk maps Clerk org roles", () => {
    expect(roleFromClerk("org:admin")).toBe("admin");
    expect(roleFromClerk("org:member")).toBe("member");
    expect(roleFromClerk(undefined)).toBe("member");
    expect(roleFromClerk(null)).toBe("member");
  });
});
