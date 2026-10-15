import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { imports, jobLogs, subscribers, type Account } from "../../src/db/schema";
import type { Db } from "../../src/db/client";
import type { QueueMessage } from "../../src/queue/messages";
import { processImport } from "../../src/queue/handlers/process-import";
import { addSuppression } from "../../src/services/suppression";
import { FakeStore, seedAccount, seedAudience, seedSubscribers, testDb } from "../helpers";
import { FORBIDDEN_KEY, KEYS, MockProviderServer } from "./mock-provider-server";

// End to end, for each provider: the real routes (list sources, start the
// import) and the real worker job (processImport) against a local server that
// serves the providers' documented responses (test/fixtures/importers). The
// assertions are on the contacts that land in the (pglite) database.
//
// Only three seams are replaced, the same ones test/import-route.test.ts uses:
// the Clerk session (requireAccount), the Redis rate limiter, and the BullMQ
// producer (its message is handed to processImport, as the worker would).

let currentDb: Db;
let currentAccount: Account;
const sent: QueueMessage[] = [];

vi.mock("../../src/api/context", () => ({
  requireAccount: async () => ({
    db: currentDb,
    account: currentAccount,
    auth: { userId: "user_test", orgId: "org_test", has: () => true },
  }),
}));
vi.mock("../../src/lib/rate-limit", () => ({ enforceRateLimit: async () => {} }));
vi.mock("../../src/queue/producer", () => ({
  getQueue: () => ({ send: async (m: QueueMessage) => void sent.push(m) }),
}));

const { POST: listSources } = await import("../../app/api/import-providers/[provider]/sources/route");
const { POST: startImport } = await import("../../app/api/audiences/[id]/import/provider/route");

const server = new MockProviderServer();
const realFetch = globalThis.fetch;

beforeAll(async () => {
  await server.start();
  vi.stubGlobal("fetch", server.providerFetch(realFetch));
  // The key is encrypted at rest with the same keyring the DNS tokens use.
  vi.stubEnv("DNS_TOKEN_ENC_KEY", Buffer.alloc(32, 7).toString("base64"));
});
afterAll(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await server.stop();
});

let audienceId: string;
beforeEach(async () => {
  server.reset();
  sent.length = 0;
  currentDb = await testDb();
  currentAccount = await seedAccount(currentDb);
  audienceId = (await seedAudience(currentDb, currentAccount.id)).id;
});

function post(handler: typeof listSources, url: string, body: unknown, params: Record<string, string>) {
  const req = new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handler(req as never, { params: Promise.resolve(params) } as never);
}

async function sources(provider: string, apiKey: string) {
  const res = await post(listSources, `http://localhost/api/import-providers/${provider}/sources`, { apiKey }, { provider });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function start(provider: string, apiKey: string, sourceId: string) {
  const res = await post(
    startImport as typeof listSources,
    `http://localhost/api/audiences/${audienceId}/import/provider`,
    { provider, apiKey, sourceId },
    { id: audienceId },
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// The worker's half: hand the queued message to the real job.
async function runQueuedJob(deps?: Parameters<typeof processImport>[3]) {
  const message = sent.shift();
  if (!message || message.type !== "process_import") throw new Error("no process_import queued");
  await processImport(message, currentDb, new FakeStore(), deps);
  return (await currentDb.query.imports.findFirst({ where: eq(imports.id, message.importId) }))!;
}

async function contacts() {
  const rows = await currentDb.select().from(subscribers).where(eq(subscribers.audienceId, audienceId));
  return new Map(rows.map((r) => [r.email, r]));
}

// Timestamps come back from Postgres in its text form; compare instants.
function iso(value: string | null | undefined): string | null {
  return value ? new Date(value).toISOString() : null;
}

// Shared invariants after any provider import.
async function expectNoOptOutSubscribed(emails: string[]) {
  const all = await contacts();
  for (const email of emails) {
    const row = all.get(email);
    expect(row?.status ?? "absent", email).not.toBe("subscribed");
  }
}

describe("beehiiv import, end to end", () => {
  const PUB = "pub_00000000-0000-0000-0000-000000000001";

  it("lists publications, imports every status correctly, and keeps the key only while running", async () => {
    // Someone who already unsubscribed in Day3 and is active at beehiiv, and a
    // suppressed address: neither may come out subscribed.
    await seedSubscribers(currentDb, currentAccount.id, audienceId, ["optedout-in-day3@example.com"], "unsubscribed");
    await addSuppression(currentDb, { accountId: currentAccount.id, email: "suppressed@example.com", reason: "bounce" });

    const listed = await sources("beehiiv", KEYS.beehiiv);
    expect(listed.status).toBe(200);
    expect(listed.body.sources).toEqual([
      { id: PUB, name: "The Daily Byte", subscribedCount: 4, totalCount: null },
      { id: "pub_00000000-0000-0000-0000-000000000002", name: "Weekend Reads", subscribedCount: 0, totalCount: null },
    ]);

    const started = await start("beehiiv", KEYS.beehiiv, PUB);
    expect(started.status).toBe(202);
    const pending = (await currentDb.query.imports.findFirst({
      where: eq(imports.id, started.body.importId as string),
    }))!;
    expect(pending.source).toBe("beehiiv");
    expect(pending.filename).toBe("beehiiv: The Daily Byte");
    // Stored encrypted, never in the clear.
    expect(pending.sourceCredential).toBeTruthy();
    expect(pending.sourceCredential).not.toContain(KEYS.beehiiv);

    const done = await runQueuedJob();
    expect(done.status).toBe("completed");
    expect(done.sourceCredential).toBeNull();
    expect(done.sourceCursor).toBeNull();
    expect(done).toMatchObject({
      totalRows: 10,
      importedRows: 4, // ada, grace (subscribed) + left, paused (unsubscribed)
      unsubscribedRows: 2,
      skippedRows: 6,
      invalidRows: 1, // status invalid
      statusSkippedRows: 3, // pending, validating, needs_attention
      duplicateRows: 1, // optedout-in-day3, already in the audience
      suppressedRows: 1,
      overCapRows: 0,
    });

    const all = await contacts();
    expect(all.get("ada@example.com")).toMatchObject({
      status: "subscribed",
      firstName: "Ada",
      lastName: "Lovelace",
      attributes: { company: "Analytical Engines", interests: "math, poetry" },
    });
    // The signup date comes over from beehiiv's `created` (epoch seconds).
    expect(iso(all.get("ada@example.com")?.createdAt)).toBe(new Date(1666800076 * 1000).toISOString());
    expect(all.get("grace@example.com")).toMatchObject({ status: "subscribed", firstName: "Grace" });
    expect(all.get("left@example.com")?.status).toBe("unsubscribed");
    expect(all.get("left@example.com")?.unsubscribedAt).toBeTruthy();
    expect(all.get("paused@example.com")?.status).toBe("unsubscribed");
    expect(all.get("optedout-in-day3@example.com")?.status).toBe("unsubscribed");
    for (const skipped of ["pending@example.com", "validating@example.com", "review@example.com", "suppressed@example.com"]) {
      expect(all.has(skipped), skipped).toBe(false);
    }
    await expectNoOptOutSubscribed(["left@example.com", "paused@example.com", "optedout-in-day3@example.com"]);

    // Cursor paging: page 2 was asked for with page 1's next_cursor, with the
    // custom fields expanded and every status included.
    const subsRequests = server.requests.filter((r) => r.path.endsWith("/subscriptions"));
    expect(subsRequests.map((r) => r.query.get("cursor"))).toEqual([null, "eyJpZCI6InN1Yl81In0"]);
    expect(subsRequests[0].query.get("status")).toBe("all");
    expect(subsRequests[0].query.get("expand[]")).toBe("custom_fields");

    // The job log carries the counts, so a live run can be checked from the DB.
    const log = await currentDb.query.jobLogs.findFirst({
      where: and(eq(jobLogs.entityId, done.id), eq(jobLogs.status, "completed")),
    });
    expect(JSON.parse(log!.payloadJson!)).toMatchObject({
      source: "beehiiv",
      imported: 4,
      subscribed: 2,
      unsubscribed: 2,
      skipped: 6,
    });
  });

  it("is idempotent: a second import adds nobody and changes no status", async () => {
    await start("beehiiv", KEYS.beehiiv, PUB);
    await runQueuedJob();
    const before = await contacts();

    // An opt-out made in Day3 between the two runs must survive the re-import.
    await currentDb
      .update(subscribers)
      .set({ status: "unsubscribed" })
      .where(and(eq(subscribers.audienceId, audienceId), eq(subscribers.email, "grace@example.com")));

    const again = await start("beehiiv", KEYS.beehiiv, PUB);
    expect(again.status).toBe(202);
    const second = await runQueuedJob();
    expect(second).toMatchObject({ status: "completed", importedRows: 0, duplicateRows: 6 });

    const after = await contacts();
    expect(after.size).toBe(before.size);
    expect(after.get("grace@example.com")?.status).toBe("unsubscribed");
  });

  it("waits out a 429 (RateLimit-Reset) and finishes", async () => {
    await start("beehiiv", KEYS.beehiiv, PUB);
    server.inject("/v2/publications/", {
      status: 429,
      headers: { "RateLimit-Limit": "30", "RateLimit-Remaining": "0", "RateLimit-Reset": "0" },
      body: { status: 429, statusText: "Too Many Requests", errors: [{ message: "Rate limit exceeded", code: "rate_limit_exceeded" }] },
    }, 2);
    const waits: number[] = [];
    const done = await runQueuedJob({ sleep: async (ms) => void waits.push(ms) });
    expect(done.status).toBe("completed");
    expect(done.importedRows).toBe(6);
    expect(waits).toHaveLength(2);
    // Two 429s, then the two real pages.
    expect(server.requests.filter((r) => r.path.endsWith("/subscriptions"))).toHaveLength(4);
  });

  it("fails clearly, keeps what it imported, and erases the key when the rate limit never lifts", async () => {
    await start("beehiiv", KEYS.beehiiv, PUB);
    server.inject("/v2/publications/", { status: 429, headers: { "Retry-After": "1" }, body: {} }, 10);
    const done = await runQueuedJob({ sleep: async () => {}, maxAttempts: 3 });
    expect(done.status).toBe("failed");
    expect(done.error).toMatch(/limiting how fast/);
    expect(done.sourceCredential).toBeNull();
  });

  it("resumes from the stored cursor after a crash, without double counting", async () => {
    const started = await start("beehiiv", KEYS.beehiiv, PUB);
    const killed = await processImportOnePage(started.body.importId as string);
    // Page 1 committed: ada (subscribed), left + paused (unsubscribed), and
    // pending + validating skipped, with page 2's cursor stored beside them.
    expect(killed).toMatchObject({
      status: "processing",
      sourceCursor: "eyJpZCI6InN1Yl81In0",
      importedRows: 3,
      statusSkippedRows: 2,
    });

    server.reset();
    // BullMQ redelivers the stalled job's message; the job picks up at page 2.
    const done = await runQueuedJob();
    expect(done).toMatchObject({
      status: "completed",
      totalRows: 10,
      // No Day3 opt-out or suppression seeded here, so all three active
      // contacts on page 2 come in: 3 + 3.
      importedRows: 6,
      unsubscribedRows: 2,
      skippedRows: 4,
      duplicateRows: 0,
      sourceCredential: null,
    });
    expect(
      server.requests.filter((r) => r.path.endsWith("/subscriptions")).map((r) => r.query.get("cursor")),
    ).toEqual(["eyJpZCI6InN1Yl81In0"]);
  });

  it("explains a bad key, a plan without API access, and an unknown publication", async () => {
    const bad = await sources("beehiiv", "not_the_right_key_123");
    expect(bad.status).toBe(422);
    expect(bad.body).toMatchObject({ code: "bad_key" });
    expect(bad.body.error).toMatch(/did not accept that API key/);

    const forbidden = await sources("beehiiv", FORBIDDEN_KEY);
    expect(forbidden.status).toBe(422);
    expect(forbidden.body).toMatchObject({ code: "no_access" });
    expect(forbidden.body.error).toMatch(/export a CSV/);

    const missing = await start("beehiiv", KEYS.beehiiv, "pub_00000000-0000-0000-0000-00000000dead");
    expect(missing.status).toBe(422);
    expect(missing.body).toMatchObject({ code: "not_found" });

    // Nothing was stored or queued for any of them.
    expect(await currentDb.select().from(imports)).toHaveLength(0);
    expect(sent).toHaveLength(0);
  });

  it("refuses up front on the Free plan when the list cannot fit", async () => {
    currentAccount = await seedAccount(currentDb, { plan: "free_org" });
    audienceId = (await seedAudience(currentDb, currentAccount.id)).id;
    // Leave 2 slots under the 500 cap; The Daily Byte has 4 active.
    await seedSubscribers(
      currentDb,
      currentAccount.id,
      audienceId,
      Array.from({ length: 498 }, (_, i) => `existing${i}@example.com`),
    );
    const res = await start("beehiiv", KEYS.beehiiv, PUB);
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/only 2 slots remain/);
  });

  it("caps at the Free plan limit in the job too (the backstop)", async () => {
    currentAccount = await seedAccount(currentDb, { plan: "free_org" });
    audienceId = (await seedAudience(currentDb, currentAccount.id)).id;
    await seedSubscribers(
      currentDb,
      currentAccount.id,
      audienceId,
      Array.from({ length: 495 }, (_, i) => `existing${i}@example.com`),
    );
    expect((await start("beehiiv", KEYS.beehiiv, PUB)).status).toBe(202);
    // Signups arrive between start and processing.
    await seedSubscribers(currentDb, currentAccount.id, audienceId, ["late1@example.com", "late2@example.com", "late3@example.com"]);
    const done = await runQueuedJob();
    expect(done.status).toBe("completed");
    expect(done.importedRows).toBe(2);
    // Page 1 had 3 importable (1 over), page 2 had 3 more (all over).
    expect(done.overCapRows).toBe(4);
  });
});

// Run the job for exactly one page, then leave the row as a killed worker would.
async function processImportOnePage(importId: string) {
  const row = (await currentDb.query.imports.findFirst({ where: eq(imports.id, importId) }))!;
  let calls = 0;
  const stopAfterOnePage: typeof fetch = async (input, init) => {
    if (String(input).includes("/subscriptions") && calls++ >= 1) {
      // The "crash": the second page never arrives and the process dies before
      // writing a terminal state. Restore the in-flight state below.
      throw new Error("worker killed");
    }
    return server.providerFetch(realFetch)(input, init);
  };
  await processImport({ type: "process_import", importId, accountId: currentAccount.id }, currentDb, new FakeStore(), {
    fetch: stopAfterOnePage,
    maxAttempts: 1,
  });
  // processImport recorded "failed" and erased the key; a real crash would not
  // have. Put back what the dead worker would have left: processing, key kept.
  await currentDb
    .update(imports)
    .set({ status: "processing", sourceCredential: row.sourceCredential, error: null })
    .where(eq(imports.id, importId));
  return (await currentDb.query.imports.findFirst({ where: eq(imports.id, importId) }))!;
}

describe("Kit import, end to end", () => {
  it("imports active as subscribed, cancelled as unsubscribed, and skips bounced, complained and unconfirmed", async () => {
    const listed = await sources("kit", KEYS.kit);
    expect(listed.status).toBe(200);
    expect(listed.body.sources).toEqual([
      { id: "account", name: "Kit Greenhouse (all subscribers)", subscribedCount: 2, totalCount: null },
    ]);
    expect((await start("kit", KEYS.kit, "account")).status).toBe(202);
    const done = await runQueuedJob();
    expect(done).toMatchObject({
      status: "completed",
      totalRows: 6,
      importedRows: 3,
      unsubscribedRows: 1,
      statusSkippedRows: 3,
      skippedRows: 3,
      sourceCredential: null,
    });
    const all = await contacts();
    expect(all.get("alice@convertkit.dev")).toMatchObject({
      status: "subscribed",
      firstName: "Alice",
      lastName: "Andersen",
      attributes: { category: "One" },
    });
    expect(all.get("benito@convertkit.dev")?.status).toBe("unsubscribed");
    expect(all.get("eve@convertkit.dev")?.status).toBe("subscribed");
    for (const gone of ["bounced@convertkit.dev", "complained@convertkit.dev", "unconfirmed@convertkit.dev"]) {
      expect(all.has(gone), gone).toBe(false);
    }
    // Cursor paging with the documented `after` parameter and the key header.
    const pages = server.requests.filter((r) => r.path === "/v4/subscribers" && r.query.get("status") === "all");
    expect(pages.map((r) => r.query.get("after"))).toEqual([null, "WzIwNl0="]);
    expect(pages[0].auth).toBe(KEYS.kit);

    // Second run: nothing new.
    await start("kit", KEYS.kit, "account");
    expect(await runQueuedJob()).toMatchObject({ importedRows: 0, duplicateRows: 3 });
  });

  it("explains a bad key", async () => {
    const bad = await sources("kit", "wrong_kit_key_0001");
    expect(bad).toMatchObject({ status: 422, body: { code: "bad_key" } });
  });
});

describe("Mailchimp import, end to end", () => {
  it("reaches the key's data center, pages by offset, and maps every member status", async () => {
    const listed = await sources("mailchimp", KEYS.mailchimp);
    expect(listed.status).toBe(200);
    expect(listed.body.sources).toEqual([
      { id: "a1b2c3d4e5", name: "Main newsletter", subscribedCount: 2, totalCount: 4 },
    ]);
    expect((await start("mailchimp", KEYS.mailchimp, "a1b2c3d4e5")).status).toBe(202);
    const done = await runQueuedJob();
    expect(done).toMatchObject({
      status: "completed",
      totalRows: 7,
      importedRows: 3,
      unsubscribedRows: 1,
      statusSkippedRows: 4, // cleaned, pending, transactional, archived
    });
    const all = await contacts();
    expect(all.get("urist@example.com")).toMatchObject({
      status: "subscribed",
      firstName: "Urist",
      lastName: "McVankab",
      attributes: { company: "Dwarf Fortress", address: "1 Main St, Boatmurdered, 1234, DK" },
    });
    expect(all.get("gone@example.com")?.status).toBe("unsubscribed");
    expect(iso(all.get("gone@example.com")?.unsubscribedAt)).toBe("2021-03-04T05:06:07.000Z");
    for (const gone of ["cleaned@example.com", "pending@example.com", "receipts@example.com", "archived@example.com"]) {
      expect(all.has(gone), gone).toBe(false);
    }
    const pages = server.requests.filter((r) => r.path.endsWith("/members"));
    expect(pages.map((r) => r.query.get("offset"))).toEqual(["0", "4"]);
  });

  it("treats a key without a data center as a bad key, without calling anyone", async () => {
    const bad = await sources("mailchimp", "fake_key_without_dc");
    expect(bad).toMatchObject({ status: 422, body: { code: "bad_key" } });
    expect(server.requests).toHaveLength(0);
  });
});

describe("MailerLite import, end to end", () => {
  it("reads active and unsubscribed separately and keeps opt-out dates", async () => {
    const listed = await sources("mailerlite", KEYS.mailerlite);
    expect(listed.body.sources).toEqual([
      { id: "account", name: "All subscribers", subscribedCount: null, totalCount: 7 },
    ]);
    expect((await start("mailerlite", KEYS.mailerlite, "account")).status).toBe(202);
    const done = await runQueuedJob();
    expect(done).toMatchObject({
      status: "completed",
      importedRows: 3,
      unsubscribedRows: 1,
      // A row whose own status disagrees with the filter is judged by its own
      // status: junk, bounced and unconfirmed are skipped.
      statusSkippedRows: 3,
    });
    const all = await contacts();
    expect(all.get("dummy@example.com")).toMatchObject({
      status: "subscribed",
      firstName: "Dummy",
      lastName: "Testerson",
      attributes: { company: "Acme" },
    });
    // "2021-09-01 14:03:50" has no zone; MailerLite means UTC.
    expect(iso(all.get("dummy@example.com")?.createdAt)).toBe("2021-09-01T14:03:50.000Z");
    expect(all.get("left@example.com")?.status).toBe("unsubscribed");
    expect(iso(all.get("left@example.com")?.unsubscribedAt)).toBe("2023-07-07T07:07:07.000Z");
    for (const gone of ["junk@example.com", "bounced@example.com", "unconfirmed@example.com"]) {
      expect(all.has(gone), gone).toBe(false);
    }
    const reads = server.requests.filter((r) => r.path === "/api/subscribers" && r.query.get("limit") !== "0");
    expect(reads.map((r) => `${r.query.get("filter[status]")}:${r.query.get("cursor") ?? ""}`)).toEqual([
      "active:",
      "active:eyJpZCI6Mn0",
      "unsubscribed:",
    ]);
  });

  it("honours MailerLite's Retry-After on a 429", async () => {
    await start("mailerlite", KEYS.mailerlite, "account");
    server.inject("/api/subscribers", {
      status: 429,
      headers: { "X-RateLimit-Limit": "120", "X-RateLimit-Remaining": "0", "Retry-After": "119" },
      body: { message: "Too Many Attempts." },
    });
    const waits: number[] = [];
    const done = await runQueuedJob({ sleep: async (ms) => void waits.push(ms) });
    expect(done.status).toBe("completed");
    expect(waits).toEqual([119_000]);
  });
});
