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

  it("skips a Mixed.Case import row when a lowercase suppression exists", async () => {
    const csv = "email\nMixed.Case@Example.com\nbob@example.com";
    const { db, store, account, audience, importId } = await createImport(csv);
    // Suppression added in lowercase; the import row arrives mixed-case.
    await addSuppression(db, {
      accountId: account.id,
      email: "mixed.case@example.com",
      reason: "unsubscribe",
    });

    await processImport({ importId, accountId: account.id }, db, store);

    const subs = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.audienceId, audience.id));
    // Mixed.Case is suppressed (canonical match) → only bob imported.
    expect(subs.map((s) => s.email).sort()).toEqual(["bob@example.com"]);
  });

  it("dedupes two casings of the same address within an audience", async () => {
    const csv = "email\nMixed.Case@Example.com\nmixed.case@example.com";
    const { db, store, account, audience, importId } = await createImport(csv);

    await processImport({ importId, accountId: account.id }, db, store);

    const subs = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.audienceId, audience.id));
    // Both rows canonicalize to the same email → unique index dedupes to one,
    // stored in canonical (lowercased) form.
    expect(subs.map((s) => s.email)).toEqual(["mixed.case@example.com"]);

    const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
    expect(importRow?.importedRows).toBe(1);
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

  // A migration that re-subscribes everyone who had already opted out at the old
  // provider is the worst thing a CSV import can do — it mails people who left,
  // which is unlawful in most places and torches a new domain's reputation. So a
  // `status` column is honoured, with the two statuses a file may assert.
  it("imports an unsubscribed row as unsubscribed, keeping its original opt-out date", async () => {
    const csv = [
      "email,first_name,status,unsubscribed_at",
      "stays@example.com,Stay,subscribed,",
      "left@example.com,Left,unsubscribed,2025-11-02",
      "gone@example.com,Gone,unsubscribe,", // no date in the file
    ].join("\n");

    const { db, store, account, audience, importId } = await createImport(csv);
    await processImport({ importId, accountId: account.id }, db, store);

    const subs = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.audienceId, audience.id));
    const byEmail = Object.fromEntries(subs.map((s) => [s.email, s]));

    expect(byEmail["stays@example.com"].status).toBe("subscribed");
    expect(byEmail["stays@example.com"].unsubscribedAt).toBeNull();
    expect(byEmail["left@example.com"].status).toBe("unsubscribed");
    expect(byEmail["left@example.com"].unsubscribedAt).toContain("2025-11-02");
    // No date in the file → stamped at import time rather than left empty.
    expect(byEmail["gone@example.com"].status).toBe("unsubscribed");
    expect(byEmail["gone@example.com"].unsubscribedAt).toBeTruthy();

    const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
    expect(importRow?.importedRows).toBe(3);
    expect(importRow?.skippedRows).toBe(0);
  });

  it("skips rows the file marks bounced, spam or unconfirmed instead of subscribing them", async () => {
    const csv = [
      "email,status",
      "ok@example.com,subscribed",
      "bounced@example.com,cleaned", // Mailchimp's word for a bounced address
      "hard@example.com,bounced",
      "spam@example.com,complained",
      "waiting@example.com,pending", // never completed double opt-in
    ].join("\n");

    const { db, store, account, audience, importId } = await createImport(csv);
    await processImport({ importId, accountId: account.id }, db, store);

    const subs = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.audienceId, audience.id));
    expect(subs.map((s) => s.email)).toEqual(["ok@example.com"]);

    const importRow = await db.query.imports.findFirst({ where: eq(imports.id, importId) });
    // Counted under their own reason — the addresses are valid, we declined them.
    expect(importRow?.statusSkippedRows).toBe(4);
    expect(importRow?.invalidRows).toBe(0);
    expect(importRow?.skippedRows).toBe(4);
  });

  it("treats an unrecognized status value as subscribed, so an unrelated column can't void an import", async () => {
    // "status" is a common header for arbitrary data (trial/paid/churned). Reading
    // it must never silently swallow somebody's whole list.
    const csv = ["email,status", "a@example.com,trial", "b@example.com,paid"].join("\n");

    const { db, store, account, audience, importId } = await createImport(csv);
    await processImport({ importId, accountId: account.id }, db, store);

    const subs = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.audienceId, audience.id));
    expect(subs.every((s) => s.status === "subscribed")).toBe(true);
    expect(subs).toHaveLength(2);
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
