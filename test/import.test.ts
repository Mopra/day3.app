import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { processImport } from "../src/queue/handlers/process-import";
import { imports, subscribers } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { addSuppression } from "../src/services/suppression";
import { FakeStore, seedAccount, seedAudience, seedSubscribers, testDb } from "./helpers";

async function createImport(csv: string) {
  const db = await testDb();
  const store = new FakeStore();
  const account = await seedAccount(db);
  const audience = await seedAudience(db, account.id);

  const importId = newId("imp");
  const r2Key = `imports/${account.id}/${importId}.csv`;
  store.put(r2Key, csv);

  const now = nowIso();
  await db.insert(imports).values({
    id: importId,
    accountId: account.id,
    audienceId: audience.id,
    r2Key,
    filename: "test.csv",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });
  return { db, store, account, audience, importId };
}

describe("process_import", () => {
  it("imports valid rows, skips invalid emails, dedupes, and skips suppressed", async () => {
    const csv = [
      "email,first_name,last_name",
      "alice@example.com,Alice,Anderson",
      "not-an-email,Nope,",
      "bob@example.com,Bob,",
      "ALICE@example.com,Dupe,", // duplicate after lowercasing
      "suppressed@example.com,Sup,",
    ].join("\n");

    const { db, store, account, audience, importId } = await createImport(csv);
    await addSuppression(db, {
      accountId: account.id,
      email: "suppressed@example.com",
      reason: "unsubscribe",
    });

    await processImport({ importId, accountId: account.id }, db, store);

    const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
    expect(importRow?.status).toBe("completed");
    expect(importRow?.totalRows).toBe(5);
    expect(importRow?.importedRows).toBe(2); // alice + bob
    expect(importRow?.skippedRows).toBe(3);

    const subs = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.audienceId, audience.id));
    expect(subs.map((s) => s.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);
  });

  it("does not duplicate existing audience members", async () => {
    const csv = "email\nalice@example.com\nnew@example.com";
    const { db, store, account, audience, importId } = await createImport(csv);
    await seedSubscribers(db, account.id, audience.id, ["alice@example.com"]);

    await processImport({ importId, accountId: account.id }, db, store);

    const subs = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.audienceId, audience.id));
    expect(subs).toHaveLength(2);

    const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
    expect(importRow?.importedRows).toBe(1);
  });

  it("is idempotent: a retried message does not re-import a completed import", async () => {
    const csv = "email\nalice@example.com";
    const { db, store, account, importId } = await createImport(csv);

    await processImport({ importId, accountId: account.id }, db, store);
    await processImport({ importId, accountId: account.id }, db, store);

    const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
    expect(importRow?.importedRows).toBe(1);
  });
});
