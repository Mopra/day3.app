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
}): ClerkClient {
  const stub = {
    organizations: {
      getOrganization: async () => ({ name: opts.orgName ?? "Acme Inc" }),
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
