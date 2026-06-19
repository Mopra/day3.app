import { beforeEach, describe, expect, it, vi } from "vitest";
import { imports } from "../src/db/schema";
import type { Db } from "../src/db/client";
import { seedAccount, seedAudience, testDb } from "./helpers";
import type { Account } from "../src/db/schema";

// Drive the import route handler directly. Auth (requireAccount) is the seam we
// replace so the handler runs against the hermetic pglite DB; storage, the queue,
// and the rate limiter are stubbed so we exercise only edge validation.
let currentDb: Db;
let currentAccount: Account;

vi.mock("../src/api/context", () => ({
  requireAccount: async () => ({
    db: currentDb,
    account: currentAccount,
    auth: { userId: "user_test", orgId: "org_test", has: () => true },
  }),
}));
vi.mock("../src/lib/rate-limit", () => ({ enforceRateLimit: async () => {} }));
const putImportObject = vi.fn(async () => {});
vi.mock("../src/lib/supabase-storage", () => ({ putImportObject }));
const send = vi.fn(async () => {});
vi.mock("../src/queue/producer", () => ({ getQueue: () => ({ send }) }));

const { POST } = await import("../app/api/audiences/[id]/import/route");

function upload(audienceId: string, file: File | null): Promise<Response> {
  const form = new FormData();
  if (file) form.set("file", file);
  const req = new Request(`http://localhost/api/audiences/${audienceId}/import`, {
    method: "POST",
    body: form,
  });
  return POST(req as never, { params: Promise.resolve({ id: audienceId }) });
}

describe("import route input validation", () => {
  let audienceId: string;

  beforeEach(async () => {
    currentDb = await testDb();
    currentAccount = await seedAccount(currentDb);
    const audience = await seedAudience(currentDb, currentAccount.id);
    audienceId = audience.id;
    putImportObject.mockClear();
    send.mockClear();
  });

  it("rejects a non-CSV content type without storing or enqueueing", async () => {
    const file = new File(["%PDF-1.4 not a csv"], "subs.pdf", { type: "application/pdf" });
    const res = await upload(audienceId, file);
    expect(res.status).toBe(400);
    expect(putImportObject).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    const rows = await currentDb.select().from(imports);
    expect(rows).toHaveLength(0);
  });

  it("rejects an empty file before storing", async () => {
    const file = new File([], "subs.csv", { type: "text/csv" });
    const res = await upload(audienceId, file);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/empty/i);
    expect(putImportObject).not.toHaveBeenCalled();
  });

  it("accepts a valid CSV, stores it, and enqueues the job", async () => {
    const file = new File(["email\na@x.co\nb@x.co"], "subs.csv", { type: "text/csv" });
    const res = await upload(audienceId, file);
    expect(res.status).toBe(202);
    expect(putImportObject).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
  });
});
