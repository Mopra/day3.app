import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import type { Account, Audience } from "../src/db/schema";
import { apiKeys, subscribers } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { seedAccount, seedAudience, testDb } from "./helpers";

// The migration recipe the /api-keys page hands to an AI assistant, executed
// end to end against the real route handlers. test/api-v1.test.ts covers each
// endpoint in isolation; this asks the different question the page's promise
// depends on — *does the documented sequence actually migrate a list?* — and
// pins the sharp edges an unattended agent will hit on a real provider export.

let currentDb: Db;

vi.mock("../src/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/client")>();
  return { ...actual, getDb: () => currentDb };
});
vi.mock("../src/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: async () => ({ allowed: true, retryAfterSeconds: 0, limit: 600, remaining: 599 }),
    enforceRateLimit: async () => {},
  };
});

const { generateApiKey } = await import("../src/api/v1/auth");
const batchRoute = await import("../app/api/v1/audiences/[audienceId]/contacts/batch/route");
const contactsRoute = await import("../app/api/v1/audiences/[audienceId]/contacts/route");
const suppressionsRoute = await import("../app/api/v1/suppressions/route");

let account: Account;
let audience: Audience;
let key: string;

function req(
  url: string,
  opts: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Request {
  const r = new Request(url, {
    method: opts.method ?? "GET",
    headers: {
      authorization: `Bearer ${key}`,
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  Object.defineProperty(r, "nextUrl", { value: new URL(url) });
  return r;
}

const params = (values: Record<string, string>) =>
  ({ params: Promise.resolve(values) }) as never;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (res: Response): Promise<any> => res.json();

const BASE = "https://go.day3.app/api/v1";
const batchUrl = () => `${BASE}/audiences/${audience.id}/contacts/batch`;

beforeEach(async () => {
  currentDb = await testDb();
  account = await seedAccount(currentDb);
  audience = await seedAudience(currentDb, account.id);
  const generated = generateApiKey();
  await currentDb.insert(apiKeys).values({
    id: newId("key"),
    accountId: account.id,
    name: "migration",
    keyHash: generated.keyHash,
    keyPrefix: generated.keyPrefix,
    createdBy: "user_test",
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  key = generated.key;
});

describe("the documented migration recipe", () => {
  it("carries subscribers, opt-outs, custom fields and bounces across in two calls", async () => {
    // A realistic provider export: active members, someone who unsubscribed two
    // years ago, a hard bounce, and a row whose email is junk.
    const cleaned = ["dead@acme.com"];
    const members = [
      { email: "ada@acme.com", first_name: "Ada", attributes: { company: "Acme", plan: "pro" } },
      { email: "grace@acme.com", first_name: "Grace", attributes: { company: "Hopper Inc" } },
      {
        email: "left@acme.com",
        first_name: "Departed",
        status: "unsubscribed" as const,
        unsubscribed_at: "2024-03-02T10:00:00.000Z",
      },
      { email: "dead@acme.com", first_name: "Bounced" },
      { email: "not-an-email", first_name: "Typo" },
    ];

    // Step 1 — suppressions first, so bounced addresses can't be re-mailed.
    const supRes = await suppressionsRoute.POST(
      req(`${BASE}/suppressions`, {
        method: "POST",
        body: { reason: "bounced", emails: cleaned },
      }) as never,
      params({}),
    );
    expect(supRes.status).toBe(200);
    const sup = await json(supRes);
    expect(sup.added).toBe(1);
    // The blast-radius numbers the prompt tells the agent to report back.
    expect(sup.total_suppressed_before).toBe(0);
    expect(sup.total_suppressed_after).toBe(1);

    // Step 2 — one batch call for the whole export.
    const batchRes = await batchRoute.POST(
      req(batchUrl(), {
        method: "POST",
        body: { upsert: true, contacts: members },
        headers: { "idempotency-key": "migration-chunk-1" },
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect(batchRes.status).toBe(200);
    const result = await json(batchRes);

    // Three land, two fail — and the call still succeeds, which is what lets an
    // unattended script keep going.
    expect(result.summary).toEqual({ created: 3, updated: 0, failed: 2 });
    const byIndex = Object.fromEntries(result.results.map((r: { index: number }) => [r.index, r]));
    expect(byIndex[3].error.code).toBe("email_suppressed");
    expect(byIndex[4].error.code).toBe("invalid_email");

    // The opt-out crossed over intact, with its original date — not today's —
    // and comes back as the ISO-8601 UTC the reference promises, so a strict
    // parser on the other end (Python fromisoformat, Go RFC3339) can read it.
    const departedOut = result.results[2].contact;
    expect(departedOut.status).toBe("unsubscribed");
    expect(departedOut.unsubscribed_at).toBe("2024-03-02T10:00:00.000Z");
    for (const field of ["created_at", "updated_at"]) {
      expect(result.results[0].contact[field]).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }

    const rows = await currentDb.query.subscribers.findMany();
    expect(rows.find((r) => r.email === "ada@acme.com")!.status).toBe("subscribed");
    expect(rows.every((r) => r.source === "api")).toBe(true);

    // Custom fields registered themselves — no schema step in the migration.
    const fields = await currentDb.query.audienceFields.findMany();
    expect(fields.map((f) => f.key).sort()).toEqual(["company", "plan"]);
  });

  it("survives the retry an interrupted migration depends on", async () => {
    const payload = {
      upsert: true,
      contacts: [{ email: "ada@acme.com", first_name: "Ada" }],
    };
    const send = () =>
      batchRoute.POST(
        req(batchUrl(), {
          method: "POST",
          body: payload,
          headers: { "idempotency-key": "chunk-7" },
        }) as never,
        params({ audienceId: audience.id }),
      );

    const first = await json(await send());
    expect(first.summary.created).toBe(1);

    // Same key, same body — the stored response is replayed, not re-applied.
    const replayRes = await send();
    expect(replayRes.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await json(replayRes)).summary.created).toBe(1);

    const rows = await currentDb.query.subscribers.findMany();
    expect(rows).toHaveLength(1);
  });

  it("re-running the whole migration updates instead of duplicating", async () => {
    const contacts = [
      { email: "ada@acme.com", first_name: "Ada", attributes: { plan: "free" } },
      { email: "grace@acme.com", first_name: "Grace" },
    ];
    const run = (idempotencyKey: string) =>
      batchRoute.POST(
        req(batchUrl(), {
          method: "POST",
          body: { upsert: true, contacts },
          headers: { "idempotency-key": idempotencyKey },
        }) as never,
        params({ audienceId: audience.id }),
      );

    expect((await json(await run("run-1"))).summary).toEqual({
      created: 2,
      updated: 0,
      failed: 0,
    });
    // A fresh idempotency key — a genuinely new run, not a retry.
    expect((await json(await run("run-2"))).summary).toEqual({
      created: 0,
      updated: 2,
      failed: 0,
    });
    expect(await currentDb.query.subscribers.findMany()).toHaveLength(2);
  });

  it("pages the whole audience back out for verification", async () => {
    const contacts = Array.from({ length: 12 }, (_, i) => ({ email: `c${i}@acme.com` }));
    await batchRoute.POST(
      req(batchUrl(), { method: "POST", body: { upsert: true, contacts } }) as never,
      params({ audienceId: audience.id }),
    );

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const url = new URL(`${BASE}/audiences/${audience.id}/contacts`);
      url.searchParams.set("limit", "5");
      if (cursor) url.searchParams.set("after", cursor);
      const page = await json(
        await contactsRoute.GET(req(url.toString()) as never, params({ audienceId: audience.id })),
      );
      seen.push(...page.data.map((c: { email: string }) => c.email));
      if (!page.has_more) break;
      cursor = page.next_cursor;
    }
    expect(new Set(seen).size).toBe(12);
  });
});

// ── The traps an unattended agent will actually hit ──────────────────────────

describe("sharp edges the reference has to warn about", () => {
  it("rejects the ENTIRE batch when an attribute value isn't a string", async () => {
    // Provider exports carry numbers and booleans (order counts, flags). A
    // single one fails schema validation for the whole call, not one row — so
    // an agent that doesn't stringify loses the batch, not the item.
    const res = await batchRoute.POST(
      req(batchUrl(), {
        method: "POST",
        body: {
          upsert: true,
          contacts: [
            { email: "ada@acme.com" },
            { email: "grace@acme.com", attributes: { orders: 5 } },
          ],
        },
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(400);
    expect((await json(res)).error.code).toBe("invalid_request");
    expect(await currentDb.query.subscribers.findMany()).toHaveLength(0);
  });

  it("silently ignores created_at, so signup dates cannot be preserved", async () => {
    const res = await batchRoute.POST(
      req(batchUrl(), {
        method: "POST",
        body: {
          upsert: true,
          contacts: [{ email: "ada@acme.com", created_at: "2019-01-01T00:00:00.000Z" }],
        },
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(200);
    const [row] = await currentDb.query.subscribers.findMany();
    expect(row.createdAt.startsWith("2019")).toBe(false);
  });

  it("silently drops reserved keys smuggled in through attributes", async () => {
    await batchRoute.POST(
      req(batchUrl(), {
        method: "POST",
        body: {
          upsert: true,
          contacts: [
            { email: "ada@acme.com", attributes: { first_name: "Wrong", company: "Acme" } },
          ],
        },
      }) as never,
      params({ audienceId: audience.id }),
    );
    const [row] = await currentDb.query.subscribers.findMany();
    // first_name is a column, not an attribute — putting it in the bag is a
    // no-op rather than an error, so a bad mapping is invisible without this.
    expect(row.firstName).toBeNull();
    expect(row.attributes).toEqual({ company: "Acme" });
  });

  it("fails the whole batch on duplicate emails within one payload", async () => {
    // Provider exports really do contain the same address twice.
    const res = await batchRoute.POST(
      req(batchUrl(), {
        method: "POST",
        body: {
          upsert: true,
          contacts: [{ email: "ada@acme.com" }, { email: "ADA@acme.com" }],
        },
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(400);
    const err = (await json(res)).error;
    expect(err.code).toBe("invalid_request");
    expect(err.message).toContain("1"); // the offending index, so a script can drop it
  });

  it("rejects the whole batch when the free plan's cap would be crossed", async () => {
    const free = await seedAccount(currentDb, { plan: "free_org" });
    const freeAudience = await seedAudience(currentDb, free.id);
    const generated = generateApiKey();
    await currentDb.insert(apiKeys).values({
      id: newId("key"),
      accountId: free.id,
      name: "free",
      keyHash: generated.keyHash,
      keyPrefix: generated.keyPrefix,
      createdBy: "user_test",
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    key = generated.key;

    const contacts = Array.from({ length: 501 }, (_, i) => ({ email: `c${i}@acme.com` }));
    const url = `${BASE}/audiences/${freeAudience.id}/contacts/batch`;
    const res = await batchRoute.POST(
      req(url, { method: "POST", body: { upsert: true, contacts } }) as never,
      params({ audienceId: freeAudience.id }),
    );
    expect(res.status).toBe(403);
    expect((await json(res)).error.code).toBe("plan_limit_reached");
    // Nothing partially applied — the migration can be retried after upgrading.
    const rows = await currentDb
      .select()
      .from(subscribers)
      .where(eq(subscribers.accountId, free.id));
    expect(rows).toHaveLength(0);
  });
});
