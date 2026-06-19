import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { imports, subscribers } from "../src/db/schema";
import type { Account } from "../src/db/schema";
import type { Db } from "../src/db/client";
import { newId, nowIso } from "../src/lib/ids";
import { processImport } from "../src/queue/handlers/process-import";
import { FakeStore, seedAccount, seedAudience, seedSubscribers, testDb } from "./helpers";

// Drive the retry route handler directly, mirroring import-route.test.ts. The
// stored object is overwritten in a shared FakeStore so we can then run the real
// process_import handler against the corrected CSV and assert no duplication.
let currentDb: Db;
let currentAccount: Account;
const store = new FakeStore();

vi.mock("../src/api/context", () => ({
  requireAccount: async () => ({
    db: currentDb,
    account: currentAccount,
    auth: { userId: "user_test", orgId: "org_test", has: () => true },
  }),
}));
vi.mock("../src/lib/rate-limit", () => ({ enforceRateLimit: async () => {} }));
vi.mock("../src/lib/supabase-storage", () => ({
  putImportObject: async (key: string, bytes: ArrayBuffer) => {
    store.put(key, new TextDecoder().decode(bytes));
  },
}));
const send = vi.fn(async () => {});
vi.mock("../src/queue/producer", () => ({ getQueue: () => ({ send }) }));

const { POST } = await import("../app/api/audiences/[id]/imports/[importId]/retry/route");

function retry(audienceId: string, importId: string, file: File | null): Promise<Response> {
  const form = new FormData();
  if (file) form.set("file", file);
  const req = new Request(
    `http://localhost/api/audiences/${audienceId}/imports/${importId}/retry`,
    { method: "POST", body: form },
  );
  return POST(req as never, { params: Promise.resolve({ id: audienceId, importId }) });
}

describe("import retry route", () => {
  let audienceId: string;
  let importId: string;
  let r2Key: string;

  beforeEach(async () => {
    currentDb = await testDb();
    currentAccount = await seedAccount(currentDb);
    const audience = await seedAudience(currentDb, currentAccount.id);
    audienceId = audience.id;
    importId = newId("imp");
    r2Key = `imports/${currentAccount.id}/${importId}.csv`;
    const now = nowIso();
    await currentDb.insert(imports).values({
      id: importId,
      accountId: currentAccount.id,
      audienceId,
      r2Key,
      filename: "broken.csv",
      status: "failed",
      error: "CSV has no email column",
      createdAt: now,
      updatedAt: now,
    });
    send.mockClear();
  });

  it("rejects retrying a non-failed import", async () => {
    await currentDb.update(imports).set({ status: "completed" }).where(eq(imports.id, importId));
    const file = new File(["email\na@x.co"], "fixed.csv", { type: "text/csv" });
    const res = await retry(audienceId, importId, file);
    expect(res.status).toBe(409);
    expect(send).not.toHaveBeenCalled();
  });

  it("resets the failed import to pending, re-stores the file, and re-enqueues", async () => {
    const file = new File(["email\na@x.co\nb@x.co"], "fixed.csv", { type: "text/csv" });
    const res = await retry(audienceId, importId, file);
    expect(res.status).toBe(202);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toMatchObject({ type: "process_import", importId });

    const row = await currentDb.query.imports.findFirst({ where: eq(imports.id, importId) });
    expect(row?.status).toBe("pending");
    expect(row?.error).toBeNull();
    expect(row?.filename).toBe("fixed.csv");
    expect(store.get(r2Key)).resolves.not.toBeNull();
  });

  it("re-running the corrected import does not duplicate already-imported subscribers", async () => {
    // Simulate a partial earlier attempt: alice already imported.
    await seedSubscribers(currentDb, currentAccount.id, audienceId, ["alice@example.com"]);

    const csv = "email\nalice@example.com\nbob@example.com";
    const file = new File([csv], "fixed.csv", { type: "text/csv" });
    const res = await retry(audienceId, importId, file);
    expect(res.status).toBe(202);

    // Run the real handler the route re-enqueued.
    await processImport({ importId, accountId: currentAccount.id }, currentDb, store);

    const subs = await currentDb
      .select()
      .from(subscribers)
      .where(eq(subscribers.audienceId, audienceId));
    expect(subs.map((s) => s.email).sort()).toEqual(["alice@example.com", "bob@example.com"]);

    const row = await currentDb.query.imports.findFirst({ where: eq(imports.id, importId) });
    expect(row?.status).toBe("completed");
    expect(row?.importedRows).toBe(1); // only bob is new
  });
});
