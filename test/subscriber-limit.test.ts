import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { imports } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { processImport } from "../src/queue/handlers/process-import";
import { countAccountSubscribers, subscriberHeadroom } from "../src/services/subscriber-limit";
import { FakeStore, seedAccount, seedAudience, seedSubscribers, testDb } from "./helpers";

// Free-tier spam protection: an account that can't send must not hoard an
// unbounded subscriber list. Paid tiers are unlimited.
function emails(n: number, prefix: string): string[] {
  return Array.from({ length: n }, (_, i) => `${prefix}${i}@example.com`);
}

async function seedImport(
  db: Awaited<ReturnType<typeof testDb>>,
  store: FakeStore,
  accountId: string,
  audienceId: string,
  csv: string,
): Promise<string> {
  const importId = newId("imp");
  const key = `imports/${accountId}/${importId}.csv`;
  store.put(key, csv);
  const now = nowIso();
  await db.insert(imports).values({
    id: importId,
    accountId,
    audienceId,
    r2Key: key,
    filename: "import.csv",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  return importId;
}

describe("subscriber cap", () => {
  it("free tier has a 500 cap; paid tiers are unlimited", async () => {
    const db = await testDb();
    const free = await seedAccount(db, {
      plan: "free_org",
      sendingEnabled: false,
      monthlyEmailLimit: 0,
    });
    const aud = await seedAudience(db, free.id);
    await seedSubscribers(db, free.id, aud.id, emails(3, "seed"));

    expect(await countAccountSubscribers(db, free.id)).toBe(3);
    expect(await subscriberHeadroom(db, free.id, "free_org")).toBe(497);

    const paid = await seedAccount(db, { clerkOrgId: "org_paid" }); // default 10k_plan
    expect(await subscriberHeadroom(db, paid.id, paid.plan)).toBe(Infinity);
  });

  it("caps a free-tier CSV import at the remaining headroom", async () => {
    const db = await testDb();
    const store = new FakeStore();
    const account = await seedAccount(db, {
      plan: "free_org",
      sendingEnabled: false,
      monthlyEmailLimit: 0,
    });
    const aud = await seedAudience(db, account.id);
    // Already at 499 of the 500 cap → only one more row may be imported.
    await seedSubscribers(db, account.id, aud.id, emails(499, "seed"));

    const importId = await seedImport(
      db,
      store,
      account.id,
      aud.id,
      "email\n" + emails(5, "new").join("\n"),
    );
    await processImport({ importId, accountId: account.id }, db, store);

    expect(await countAccountSubscribers(db, account.id)).toBe(500);
    const row = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
    expect(row?.status).toBe("completed");
    expect(row?.importedRows).toBe(1);
    expect(row?.skippedRows).toBe(4);
  });

  it("does not cap a paid-tier import", async () => {
    const db = await testDb();
    const store = new FakeStore();
    const account = await seedAccount(db); // default 10k_plan → unlimited subscribers
    const aud = await seedAudience(db, account.id);

    const importId = await seedImport(
      db,
      store,
      account.id,
      aud.id,
      "email\n" + emails(600, "p").join("\n"),
    );
    await processImport({ importId, accountId: account.id }, db, store);

    expect(await countAccountSubscribers(db, account.id)).toBe(600);
  });
});
