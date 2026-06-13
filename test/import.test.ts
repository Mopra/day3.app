import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { processImport } from "../src/worker/queue/handlers/process-import";
import { imports, subscribers } from "../src/worker/db/schema";
import { newId, nowIso } from "../src/worker/lib/ids";
import { addSuppression } from "../src/worker/services/suppression";
import { seedAccount, seedAudience, seedSubscribers, testDb, testEnv } from "./helpers";

async function createImport(csv: string) {
  const db = testDb();
  const account = await seedAccount(db);
  const audience = await seedAudience(db, account.id);

  const importId = newId("imp");
  const r2Key = `imports/${account.id}/${importId}.csv`;
  await testEnv.IMPORTS_BUCKET.put(r2Key, csv);

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
  return { db, account, audience, importId };
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

    const { db, account, audience, importId } = await createImport(csv);
    await addSuppression(db, {
      accountId: account.id,
      email: "suppressed@example.com",
      reason: "unsubscribe",
    });

    await processImport({ importId, accountId: account.id }, db, testEnv.IMPORTS_BUCKET);

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
    const { db, account, audience, importId } = await createImport(csv);
    await seedSubscribers(db, account.id, audience.id, ["alice@example.com"]);

    await processImport({ importId, accountId: account.id }, db, testEnv.IMPORTS_BUCKET);

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
    const { db, account, importId } = await createImport(csv);

    await processImport({ importId, accountId: account.id }, db, testEnv.IMPORTS_BUCKET);
    await processImport({ importId, accountId: account.id }, db, testEnv.IMPORTS_BUCKET);

    const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
    expect(importRow?.importedRows).toBe(1);
  });
});
