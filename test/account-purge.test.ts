import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";
import type { Db } from "../src/db/client";
import {
  accountUsers,
  accounts,
  audienceFields,
  audiences,
  campaignRecipients,
  campaigns,
  dnsIntegrations,
  emailEvents,
  forms,
  imports,
  notifications,
  riskReviews,
  segments,
  senders,
  sendingDomains,
  subscribers,
  suppressionEntries,
  topicSubscriptions,
  topics,
} from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { purgeAccountData } from "../src/services/account-purge";
import { purgeAccount } from "../src/queue/handlers/purge-account";
import {
  countAccountMembers,
  handleUserDeleted,
  removeMembershipAndMaybePurge,
} from "../src/services/accounts";
import { addSuppression } from "../src/services/suppression";
import type { EmailProvider, SendEmailResult } from "../src/email/provider";
import type { ObjectStore } from "../src/lib/storage";
import { testDb, seedAccount, seedDomain, seedAudience, FakeQueue } from "./helpers";

// Seeds exactly one row in every account-scoped table for `accountId`, so a purge
// can be asserted to leave nothing behind. Returns nothing — the assertions
// re-query by account id.
async function seedOneOfEverything(db: Db, accountId: string): Promise<void> {
  const now = nowIso();
  const domain = await seedDomain(db, accountId);
  const audience = await seedAudience(db, accountId);

  await db.insert(accountUsers).values({
    id: newId("usr"), accountId, clerkUserId: `user_${newId("u")}`,
    email: "member@example.com", role: "admin", createdAt: now, updatedAt: now,
  });
  await db.insert(senders).values({
    id: newId("snd"), accountId, sendingDomainId: domain.id,
    fromName: "Test", fromEmail: "news@updates.test.co", createdAt: now, updatedAt: now,
  });
  await db.insert(dnsIntegrations).values({
    id: newId("dns"), accountId, accessTokenEnc: "enc", refreshTokenEnc: "enc",
    createdAt: now, updatedAt: now,
  });
  const sub = await db.insert(subscribers).values({
    id: newId("sub"), accountId, audienceId: audience.id, email: "s@example.com",
    createdAt: now, updatedAt: now,
  }).returning({ id: subscribers.id });
  await db.insert(audienceFields).values({
    id: newId("fld"), accountId, audienceId: audience.id, key: "company", label: "Company",
    createdAt: now, updatedAt: now,
  });
  await db.insert(segments).values({
    id: newId("seg"), accountId, audienceId: audience.id, name: "Active",
    filterJson: "{}", createdAt: now, updatedAt: now,
  });
  const topic = await db.insert(topics).values({
    id: newId("top"), accountId, audienceId: audience.id, name: "News",
    createdAt: now, updatedAt: now,
  }).returning({ id: topics.id });
  await db.insert(topicSubscriptions).values({
    id: newId("tsub"), accountId, topicId: topic[0].id, subscriberId: sub[0].id,
    subscribed: false, createdAt: now, updatedAt: now,
  });
  await db.insert(forms).values({
    id: newId("frm"), accountId, audienceId: audience.id, slug: "join", name: "Join",
    createdAt: now, updatedAt: now,
  });
  await db.insert(imports).values({
    id: newId("imp"), accountId, audienceId: audience.id,
    r2Key: `imports/${accountId}/x.csv`, filename: "x.csv", createdAt: now, updatedAt: now,
  });
  const campaign = await db.insert(campaigns).values({
    id: newId("cmp"), accountId, audienceId: audience.id, sendingDomainId: domain.id,
    name: "C", subject: "S", fromName: "T", fromEmail: "news@updates.test.co",
    htmlBody: "<p>hi</p>", createdAt: now, updatedAt: now,
  }).returning({ id: campaigns.id });
  await db.insert(campaignRecipients).values({
    id: newId("rcp"), campaignId: campaign[0].id, accountId, email: "s@example.com",
    createdAt: now, updatedAt: now,
  });
  await db.insert(emailEvents).values({
    id: newId("evt"), accountId, campaignId: campaign[0].id, eventType: "sent",
    createdAt: now,
  });
  await db.insert(riskReviews).values({
    id: newId("rsk"), accountId, campaignId: campaign[0].id, riskLevel: "low", riskScore: 0,
    categoriesJson: "[]", summary: "ok", recommendedAction: "send", createdAt: now,
  });
  await db.insert(notifications).values({
    id: newId("ntf"), accountId, kind: "campaign_sent", title: "Sent", body: "done",
    createdAt: now,
  });
  // Two suppression rows: this account's own (must be erased) and a global one
  // that happens to carry this account's id (must survive).
  await addSuppression(db, { accountId, email: "own@example.com", reason: "unsubscribe", scope: "account" });
  await addSuppression(db, { accountId, email: "gone@example.com", reason: "complaint", scope: "global" });
}

// Every account-scoped table, for exhaustive "nothing left behind" assertions.
// (suppression_entries is excluded — it's only partially erased; see its own test.)
type ScopedTable = PgTable & { accountId: PgColumn };
const SCOPED_TABLES: ScopedTable[] = [
  accountUsers, senders, dnsIntegrations, subscribers, audienceFields, segments, topics,
  topicSubscriptions, forms, imports, campaignRecipients, emailEvents, riskReviews,
  notifications, campaigns, sendingDomains, audiences,
];

async function rowsForAccount(db: Db, table: ScopedTable, accountId: string) {
  return db.select().from(table).where(eq(table.accountId, accountId));
}

describe("purgeAccountData", () => {
  it("erases every account-scoped row and the account itself", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedOneOfEverything(db, account.id);

    // Sanity: each table has a row before the purge.
    for (const table of SCOPED_TABLES) {
      expect((await rowsForAccount(db, table, account.id)).length).toBeGreaterThan(0);
    }

    await purgeAccountData(db, account.id);

    for (const table of SCOPED_TABLES) {
      expect(await rowsForAccount(db, table, account.id)).toHaveLength(0);
    }
    expect(await db.select().from(accounts).where(eq(accounts.id, account.id))).toHaveLength(0);
  });

  it("deletes account-scoped suppression but keeps global suppression", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedOneOfEverything(db, account.id);

    await purgeAccountData(db, account.id);

    const remaining = await db.select().from(suppressionEntries);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].scope).toBe("global");
    expect(remaining[0].email).toBe("gone@example.com");
  });

  it("leaves other accounts untouched", async () => {
    const db = await testDb();
    const target = await seedAccount(db);
    const bystander = await seedAccount(db);
    await seedOneOfEverything(db, target.id);
    await seedOneOfEverything(db, bystander.id);

    await purgeAccountData(db, target.id);

    for (const table of SCOPED_TABLES) {
      expect((await rowsForAccount(db, table, bystander.id)).length).toBeGreaterThan(0);
    }
    expect(await db.select().from(accounts).where(eq(accounts.id, bystander.id))).toHaveLength(1);
  });
});

describe("purgeAccount handler", () => {
  it("erases the DB and tears down SES identities + storage best-effort", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedDomain(db, account.id, { domain: "a.test.co" });
    await seedDomain(db, account.id, { domain: "b.test.co" });

    const deletedIdentities: string[] = [];
    const purgedStorage: string[] = [];
    const provider: EmailProvider = {
      async send(): Promise<SendEmailResult> {
        return { provider: "mock", status: "sent" };
      },
      async deleteIdentity(identity) {
        deletedIdentities.push(identity);
      },
    };
    const store: ObjectStore = {
      async get() {
        return null;
      },
      async purgeAccount(accountId) {
        purgedStorage.push(accountId);
      },
    };

    await purgeAccount({ accountId: account.id }, { db, emailProvider: provider, store });

    expect(await db.select().from(accounts).where(eq(accounts.id, account.id))).toHaveLength(0);
    expect(deletedIdentities.sort()).toEqual(["a.test.co", "b.test.co"]);
    expect(purgedStorage).toEqual([account.id]);
  });

  it("still erases the DB when external teardown throws", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedDomain(db, account.id);

    const provider: EmailProvider = {
      async send(): Promise<SendEmailResult> {
        return { provider: "mock", status: "sent" };
      },
      async deleteIdentity() {
        throw new Error("SES down");
      },
    };
    const store: ObjectStore = {
      async get() {
        return null;
      },
      async purgeAccount() {
        throw new Error("storage down");
      },
    };

    await expect(
      purgeAccount({ accountId: account.id }, { db, emailProvider: provider, store }),
    ).resolves.toBeUndefined();
    expect(await db.select().from(accounts).where(eq(accounts.id, account.id))).toHaveLength(0);
  });
});

describe("membership-driven purge", () => {
  async function seedMember(db: Db, accountId: string, clerkUserId: string) {
    const now = nowIso();
    await db.insert(accountUsers).values({
      id: newId("usr"), accountId, clerkUserId,
      email: `${clerkUserId}@example.com`, role: "admin", createdAt: now, updatedAt: now,
    });
  }

  it("removeMembershipAndMaybePurge purges when the last member leaves", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedMember(db, account.id, "user_solo");
    const queue = new FakeQueue();

    await removeMembershipAndMaybePurge(db, queue, account.clerkOrgId, "user_solo");

    expect(await countAccountMembers(db, account.id)).toBe(0);
    expect(queue.messages).toContainEqual({ type: "purge_account", accountId: account.id });
  });

  it("removeMembershipAndMaybePurge does NOT purge when other members remain", async () => {
    const db = await testDb();
    const account = await seedAccount(db);
    await seedMember(db, account.id, "user_a");
    await seedMember(db, account.id, "user_b");
    const queue = new FakeQueue();

    await removeMembershipAndMaybePurge(db, queue, account.clerkOrgId, "user_a");

    expect(await countAccountMembers(db, account.id)).toBe(1);
    expect(queue.messages).toHaveLength(0);
  });

  it("handleUserDeleted strips the user everywhere and purges any org left empty", async () => {
    const db = await testDb();
    const solo = await seedAccount(db); // user is the only member → purge
    const shared = await seedAccount(db); // another member remains → keep
    await seedMember(db, solo.id, "user_x");
    await seedMember(db, shared.id, "user_x");
    await seedMember(db, shared.id, "user_y");
    const queue = new FakeQueue();

    await handleUserDeleted(db, queue, "user_x");

    // The deleted user's PII is gone from both orgs.
    expect(
      await db.select().from(accountUsers).where(eq(accountUsers.clerkUserId, "user_x")),
    ).toHaveLength(0);
    // The shared org keeps its remaining member and is not purged.
    expect(await countAccountMembers(db, shared.id)).toBe(1);
    // Only the solo org is enqueued for purge.
    expect(queue.messages).toEqual([{ type: "purge_account", accountId: solo.id }]);
  });
});
