import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import type { Account, Audience } from "../src/db/schema";
import { apiKeys, subscribers, suppressionEntries, topics } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { seedAccount, seedAudience, seedSubscribers, testDb } from "./helpers";

// The v1 routes resolve their DB via getDb (inside requireApiKey); rate
// limiting is Redis-backed. Both seams are replaced here — key auth itself
// runs REAL (hashing, revocation, tenant scoping are the point of the suite).
let currentDb: Db;

vi.mock("../src/db/client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/db/client")>();
  return { ...actual, getDb: () => currentDb };
});
vi.mock("../src/lib/rate-limit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/rate-limit")>();
  return {
    ...actual,
    checkRateLimit: async () => ({
      allowed: true,
      retryAfterSeconds: 0,
      limit: 600,
      remaining: 599,
    }),
    enforceRateLimit: async () => {},
  };
});

const { generateApiKey } = await import("../src/api/v1/auth");
const audiencesRoute = await import("../app/api/v1/audiences/route");
const audienceItemRoute = await import("../app/api/v1/audiences/[audienceId]/route");
const contactsRoute = await import("../app/api/v1/audiences/[audienceId]/contacts/route");
const contactItemRoute = await import(
  "../app/api/v1/audiences/[audienceId]/contacts/[contactRef]/route"
);
const contactTopicsRoute = await import(
  "../app/api/v1/audiences/[audienceId]/contacts/[contactRef]/topics/route"
);
const batchRoute = await import("../app/api/v1/audiences/[audienceId]/contacts/batch/route");
const fieldsRoute = await import("../app/api/v1/audiences/[audienceId]/fields/route");
const fieldItemRoute = await import(
  "../app/api/v1/audiences/[audienceId]/fields/[fieldRef]/route"
);
const segmentsRoute = await import("../app/api/v1/audiences/[audienceId]/segments/route");
const segmentContactsRoute = await import(
  "../app/api/v1/audiences/[audienceId]/segments/[segmentId]/contacts/route"
);
const suppressionsRoute = await import("../app/api/v1/suppressions/route");
const suppressionItemRoute = await import("../app/api/v1/suppressions/[email]/route");

let account: Account;
let audience: Audience;
let liveKey: string;

async function seedApiKey(accountId: string): Promise<string> {
  const { key, keyHash, keyPrefix } = generateApiKey();
  const now = nowIso();
  await currentDb.insert(apiKeys).values({
    id: newId("key"),
    accountId,
    name: "test",
    keyHash,
    keyPrefix,
    createdBy: "user_test",
    createdAt: now,
    updatedAt: now,
  });
  return key;
}

function v1Req(
  url: string,
  opts: { method?: string; body?: unknown; key?: string; headers?: Record<string, string> } = {},
): Request {
  const req = new Request(url, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.key === undefined ? {} : { authorization: `Bearer ${opts.key}` }),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
      ...opts.headers,
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  Object.defineProperty(req, "nextUrl", { value: new URL(url) });
  return req;
}

function params(values: Record<string, string>) {
  return { params: Promise.resolve(values) } as never;
}

type Json = Record<string, never> & Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
async function body(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

beforeEach(async () => {
  currentDb = await testDb();
  account = await seedAccount(currentDb);
  audience = await seedAudience(currentDb, account.id);
  liveKey = await seedApiKey(account.id);
});

describe("v1 auth", () => {
  it("rejects a missing, malformed, unknown, and revoked key with stable codes", async () => {
    const url = "https://day3.app/api/v1/audiences";

    let res = await audiencesRoute.GET(v1Req(url) as never, params({}));
    expect(res.status).toBe(401);
    expect((await body(res)).error.code).toBe("invalid_api_key");

    res = await audiencesRoute.GET(v1Req(url, { key: "nonsense" }) as never, params({}));
    expect(res.status).toBe(401);

    const { key: unknownKey } = generateApiKey();
    res = await audiencesRoute.GET(v1Req(url, { key: unknownKey }) as never, params({}));
    expect(res.status).toBe(401);

    await currentDb.update(apiKeys).set({ revokedAt: nowIso() });
    res = await audiencesRoute.GET(v1Req(url, { key: liveKey }) as never, params({}));
    expect(res.status).toBe(401);
    expect((await body(res)).error.code).toBe("revoked_api_key");
  });

  it("rejects test-mode keys with a clear error", async () => {
    const testKey = liveKey.replace("day3_live_", "day3_test_");
    const res = await audiencesRoute.GET(
      v1Req("https://day3.app/api/v1/audiences", { key: testKey }) as never,
      params({}),
    );
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("test_keys_not_supported");
  });

  it("scopes everything to the key's account — cross-tenant ids read as 404", async () => {
    const other = await seedAccount(currentDb);
    const otherAudience = await seedAudience(currentDb, other.id);

    const res = await audienceItemRoute.GET(
      v1Req(`https://day3.app/api/v1/audiences/${otherAudience.id}`, { key: liveKey }) as never,
      params({ audienceId: otherAudience.id }),
    );
    expect(res.status).toBe(404);
    expect((await body(res)).error.code).toBe("not_found");
  });
});

describe("v1 audiences", () => {
  it("creates, gets (with contact_counts), patches, lists and deletes", async () => {
    let res = await audiencesRoute.POST(
      v1Req("https://day3.app/api/v1/audiences", {
        method: "POST",
        key: liveKey,
        body: { name: "Newsletter" },
      }) as never,
      params({}),
    );
    expect(res.status).toBe(201);
    const created = await body(res);
    expect(created.object).toBe("audience");

    await seedSubscribers(currentDb, account.id, created.id, ["a@x.com", "b@x.com"]);

    res = await audienceItemRoute.GET(
      v1Req(`https://day3.app/api/v1/audiences/${created.id}`, { key: liveKey }) as never,
      params({ audienceId: created.id }),
    );
    expect((await body(res)).contact_counts).toEqual({ subscribed: 2, total: 2 });

    res = await audiencesRoute.GET(
      v1Req("https://day3.app/api/v1/audiences?limit=1", { key: liveKey }) as never,
      params({}),
    );
    const list = await body(res);
    expect(list.data.length).toBe(1);
    expect(list.has_more).toBe(true);
    expect(list.next_cursor).toBeTruthy();

    res = await audienceItemRoute.DELETE(
      v1Req(`https://day3.app/api/v1/audiences/${created.id}`, {
        method: "DELETE",
        key: liveKey,
      }) as never,
      params({ audienceId: created.id }),
    );
    expect((await body(res)).deleted).toBe(true);
    const remaining = await currentDb
      .select()
      .from(subscribers)
      .where(eq(subscribers.audienceId, created.id));
    expect(remaining.length).toBe(0);
  });
});

describe("v1 contacts", () => {
  const base = () => `https://day3.app/api/v1/audiences/${audience.id}/contacts`;

  it("creates a contact, auto-registers attribute fields, 409s on duplicate", async () => {
    let res = await contactsRoute.POST(
      v1Req(base(), {
        method: "POST",
        key: liveKey,
        body: { email: "Jane@Acme.com", first_name: "Jane", attributes: { company: "Acme" } },
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(201);
    const contact = await body(res);
    expect(contact.email).toBe("jane@acme.com");
    expect(contact.attributes).toEqual({ company: "Acme" });
    expect(contact.source).toBe("api");

    // The attribute key joined the field registry.
    const fieldsRes = await fieldsRoute.GET(
      v1Req(`https://day3.app/api/v1/audiences/${audience.id}/fields`, { key: liveKey }) as never,
      params({ audienceId: audience.id }),
    );
    expect((await body(fieldsRes)).data.map((f: Json) => f.key)).toContain("company");

    res = await contactsRoute.POST(
      v1Req(base(), { method: "POST", key: liveKey, body: { email: "jane@acme.com" } }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe("contact_already_exists");
  });

  it("upsert=true updates in place with shallow attribute merge (null deletes)", async () => {
    await contactsRoute.POST(
      v1Req(base(), {
        method: "POST",
        key: liveKey,
        body: { email: "jane@acme.com", attributes: { company: "Acme", plan: "pro" } },
      }) as never,
      params({ audienceId: audience.id }),
    );

    const res = await contactsRoute.POST(
      v1Req(`${base()}?upsert=true`, {
        method: "POST",
        key: liveKey,
        body: { email: "jane@acme.com", first_name: "Jane", attributes: { plan: null, seats: "5" } },
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(200);
    const updated = await body(res);
    expect(updated.first_name).toBe("Jane");
    expect(updated.attributes).toEqual({ company: "Acme", seats: "5" });
  });

  it("accepts unsubscribed status on create (migration opt-out carry-over)", async () => {
    const res = await contactsRoute.POST(
      v1Req(base(), {
        method: "POST",
        key: liveKey,
        body: {
          email: "gone@acme.com",
          status: "unsubscribed",
          unsubscribed_at: "2025-11-02T10:00:00.000Z",
        },
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(201);
    const contact = await body(res);
    expect(contact.status).toBe("unsubscribed");
    expect(contact.unsubscribed_at).toContain("2025-11-02");
  });

  it("is addressable by email, PATCH flips status but never off pipeline-owned ones", async () => {
    await contactsRoute.POST(
      v1Req(base(), { method: "POST", key: liveKey, body: { email: "jane@acme.com" } }) as never,
      params({ audienceId: audience.id }),
    );

    let res = await contactItemRoute.GET(
      v1Req(`${base()}/jane%40acme.com`, { key: liveKey }) as never,
      params({ audienceId: audience.id, contactRef: "jane%40acme.com" }),
    );
    expect(res.status).toBe(200);
    const contact = await body(res);

    res = await contactItemRoute.PATCH(
      v1Req(`${base()}/${contact.id}`, {
        method: "PATCH",
        key: liveKey,
        body: { status: "unsubscribed" },
      }) as never,
      params({ audienceId: audience.id, contactRef: contact.id }),
    );
    expect((await body(res)).status).toBe("unsubscribed");

    await currentDb
      .update(subscribers)
      .set({ status: "bounced" })
      .where(eq(subscribers.id, contact.id));
    res = await contactItemRoute.PATCH(
      v1Req(`${base()}/${contact.id}`, {
        method: "PATCH",
        key: liveKey,
        body: { status: "subscribed" },
      }) as never,
      params({ audienceId: audience.id, contactRef: contact.id }),
    );
    expect(res.status).toBe(422);
    expect((await body(res)).error.code).toBe("immutable_field");
  });

  it("rejects suppressed emails with 409 email_suppressed", async () => {
    await currentDb.insert(suppressionEntries).values({
      id: newId("sup"),
      accountId: account.id,
      email: "spam@acme.com",
      scope: "account",
      reason: "complaint",
      createdAt: nowIso(),
    });
    const res = await contactsRoute.POST(
      v1Req(base(), { method: "POST", key: liveKey, body: { email: "spam@acme.com" } }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe("email_suppressed");
  });

  it("enforces the free-tier subscriber cap with plan_limit_reached", async () => {
    const freeAccount = await seedAccount(currentDb, { plan: "free_org" });
    const freeAudience = await seedAudience(currentDb, freeAccount.id);
    const freeKey = await seedApiKey(freeAccount.id);
    await seedSubscribers(
      currentDb,
      freeAccount.id,
      freeAudience.id,
      Array.from({ length: 500 }, (_, i) => `bulk${i}@x.com`),
    );

    const res = await contactsRoute.POST(
      v1Req(`https://day3.app/api/v1/audiences/${freeAudience.id}/contacts`, {
        method: "POST",
        key: freeKey,
        body: { email: "one-more@x.com" },
      }) as never,
      params({ audienceId: freeAudience.id }),
    );
    expect(res.status).toBe(403);
    expect((await body(res)).error.code).toBe("plan_limit_reached");
  });
});

describe("v1 contact batch", () => {
  const url = () => `https://day3.app/api/v1/audiences/${audience.id}/contacts/batch`;

  it("returns per-row results: created / updated / failed", async () => {
    await seedSubscribers(currentDb, account.id, audience.id, ["existing@x.com"]);
    await currentDb.insert(suppressionEntries).values({
      id: newId("sup"),
      accountId: account.id,
      email: "blocked@x.com",
      scope: "account",
      reason: "hard_bounce",
      createdAt: nowIso(),
    });

    const res = await batchRoute.POST(
      v1Req(url(), {
        method: "POST",
        key: liveKey,
        body: {
          upsert: true,
          contacts: [
            { email: "new@x.com", attributes: { plan: "pro" } },
            { email: "existing@x.com", first_name: "Updated" },
            { email: "blocked@x.com" },
            { email: "not-an-email" },
          ],
        },
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(200);
    const result = await body(res);
    expect(result.summary).toEqual({ created: 1, updated: 1, failed: 2 });
    expect(result.results[0].status).toBe("created");
    expect(result.results[1].status).toBe("updated");
    expect(result.results[2].error.code).toBe("email_suppressed");
    expect(result.results[3].error.code).toBe("invalid_email");
  });

  it("rejects the whole batch on in-payload duplicates, with indexes", async () => {
    const res = await batchRoute.POST(
      v1Req(url(), {
        method: "POST",
        key: liveKey,
        body: { contacts: [{ email: "a@x.com" }, { email: "A@X.com" }] },
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(400);
    const err = (await body(res)).error;
    expect(err.code).toBe("invalid_request");
    expect(err.message).toContain("1");
  });

  it("rejects the whole batch when the free-tier cap would be crossed", async () => {
    const freeAccount = await seedAccount(currentDb, { plan: "free_org" });
    const freeAudience = await seedAudience(currentDb, freeAccount.id);
    const freeKey = await seedApiKey(freeAccount.id);
    await seedSubscribers(
      currentDb,
      freeAccount.id,
      freeAudience.id,
      Array.from({ length: 499 }, (_, i) => `bulk${i}@x.com`),
    );

    const res = await batchRoute.POST(
      v1Req(`https://day3.app/api/v1/audiences/${freeAudience.id}/contacts/batch`, {
        method: "POST",
        key: freeKey,
        body: { contacts: [{ email: "one@y.com" }, { email: "two@y.com" }] },
      }) as never,
      params({ audienceId: freeAudience.id }),
    );
    expect(res.status).toBe(403);
    // Nothing partially applied.
    const rows = await currentDb
      .select()
      .from(subscribers)
      .where(eq(subscribers.audienceId, freeAudience.id));
    expect(rows.length).toBe(499);
  });

  it("applies per-contact topic choices", async () => {
    const now = nowIso();
    const topicId = newId("top");
    await currentDb.insert(topics).values({
      id: topicId,
      accountId: account.id,
      audienceId: audience.id,
      name: "Promotions",
      defaultSubscribed: true,
      createdAt: now,
      updatedAt: now,
    });

    const res = await batchRoute.POST(
      v1Req(url(), {
        method: "POST",
        key: liveKey,
        body: { contacts: [{ email: "opted-out@x.com", topics: { [topicId]: false } }] },
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect((await body(res)).summary.created).toBe(1);

    const topicsRes = await contactTopicsRoute.GET(
      v1Req(`https://day3.app/api/v1/audiences/${audience.id}/contacts/opted-out%40x.com/topics`, {
        key: liveKey,
      }) as never,
      params({ audienceId: audience.id, contactRef: "opted-out%40x.com" }),
    );
    const topicState = (await body(topicsRes)).data;
    expect(topicState).toEqual([
      { topic_id: topicId, name: "Promotions", subscribed: false, is_default: false },
    ]);
  });

  it("replays an identical request via Idempotency-Key and 409s a body change", async () => {
    const payload = { contacts: [{ email: "idem@x.com" }] };
    const headers = { "idempotency-key": "migrate-batch-1" };

    let res = await batchRoute.POST(
      v1Req(url(), { method: "POST", key: liveKey, body: payload, headers }) as never,
      params({ audienceId: audience.id }),
    );
    expect((await body(res)).summary.created).toBe(1);

    res = await batchRoute.POST(
      v1Req(url(), { method: "POST", key: liveKey, body: payload, headers }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.headers.get("Idempotency-Replayed")).toBe("true");
    expect((await body(res)).summary.created).toBe(1); // replayed, not re-run
    const rows = await currentDb
      .select()
      .from(subscribers)
      .where(eq(subscribers.email, "idem@x.com"));
    expect(rows.length).toBe(1);

    res = await batchRoute.POST(
      v1Req(url(), {
        method: "POST",
        key: liveKey,
        body: { contacts: [{ email: "other@x.com" }] },
        headers,
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(409);
    expect((await body(res)).error.code).toBe("idempotency_conflict");
  });
});

describe("v1 fields", () => {
  it("declares a field, refuses key edits (immutable_field)", async () => {
    const base = `https://day3.app/api/v1/audiences/${audience.id}/fields`;
    let res = await fieldsRoute.POST(
      v1Req(base, {
        method: "POST",
        key: liveKey,
        body: { key: "company", label: "Company", type: "text", fallback: "your company" },
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(201);
    const field = await body(res);
    expect(field.fallback).toBe("your company");

    res = await fieldItemRoute.PATCH(
      v1Req(`${base}/company`, { method: "PATCH", key: liveKey, body: { key: "org" } }) as never,
      params({ audienceId: audience.id, fieldRef: "company" }),
    );
    expect(res.status).toBe(422);
    expect((await body(res)).error.code).toBe("immutable_field");
  });
});

describe("v1 segments", () => {
  it("creates a segment and lists its live matches", async () => {
    const [pro] = await seedSubscribers(currentDb, account.id, audience.id, [
      "pro@x.com",
      "free@x.com",
    ]);
    await currentDb
      .update(subscribers)
      .set({ attributes: { plan: "pro" } })
      .where(eq(subscribers.id, pro.id));

    const res = await segmentsRoute.POST(
      v1Req(`https://day3.app/api/v1/audiences/${audience.id}/segments`, {
        method: "POST",
        key: liveKey,
        body: {
          name: "Pro users",
          filter: { match: "all", conditions: [{ field: "plan", op: "equals", value: "pro" }] },
        },
      }) as never,
      params({ audienceId: audience.id }),
    );
    expect(res.status).toBe(201);
    const segment = await body(res);
    expect(segment.filter.conditions.length).toBe(1);

    const membersRes = await segmentContactsRoute.GET(
      v1Req(
        `https://day3.app/api/v1/audiences/${audience.id}/segments/${segment.id}/contacts`,
        { key: liveKey },
      ) as never,
      params({ audienceId: audience.id, segmentId: segment.id }),
    );
    const members = await body(membersRes);
    expect(members.data.map((c: Json) => c.email)).toEqual(["pro@x.com"]);
  });
});

describe("v1 suppressions", () => {
  it("imports with explicit reason, reports blast radius, is add-only + idempotent re-add", async () => {
    let res = await suppressionsRoute.POST(
      v1Req("https://day3.app/api/v1/suppressions", {
        method: "POST",
        key: liveKey,
        body: { reason: "bounced", emails: ["a@x.com", "b@x.com", "not-an-email", "A@X.com"] },
      }) as never,
      params({}),
    );
    expect(res.status).toBe(200);
    let result = await body(res);
    expect(result).toMatchObject({
      reason: "bounced",
      added: 2, // a@x.com deduped against A@X.com
      already_suppressed: 0,
      invalid: 1,
      total_suppressed_before: 0,
      total_suppressed_after: 2,
    });

    // Re-adding is counted, not duplicated.
    res = await suppressionsRoute.POST(
      v1Req("https://day3.app/api/v1/suppressions", {
        method: "POST",
        key: liveKey,
        body: { reason: "bounced", emails: ["a@x.com", "c@x.com"] },
      }) as never,
      params({}),
    );
    result = await body(res);
    expect(result.added).toBe(1);
    expect(result.already_suppressed).toBe(1);
    expect(result.total_suppressed_after).toBe(3);

    // reason is required — no silent default.
    res = await suppressionsRoute.POST(
      v1Req("https://day3.app/api/v1/suppressions", {
        method: "POST",
        key: liveKey,
        body: { emails: ["d@x.com"] },
      }) as never,
      params({}),
    );
    expect(res.status).toBe(400);
  });

  it("checks a single email (both account and public reason vocabulary)", async () => {
    await suppressionsRoute.POST(
      v1Req("https://day3.app/api/v1/suppressions", {
        method: "POST",
        key: liveKey,
        body: { reason: "complained", emails: ["angry@x.com"] },
      }) as never,
      params({}),
    );

    let res = await suppressionItemRoute.GET(
      v1Req("https://day3.app/api/v1/suppressions/angry%40x.com", { key: liveKey }) as never,
      params({ email: "angry%40x.com" }),
    );
    expect(res.status).toBe(200);
    expect((await body(res)).reason).toBe("complained");

    res = await suppressionItemRoute.GET(
      v1Req("https://day3.app/api/v1/suppressions/clean%40x.com", { key: liveKey }) as never,
      params({ email: "clean%40x.com" }),
    );
    expect(res.status).toBe(404);
  });
});

describe("v1 pagination", () => {
  it("walks contacts with stable cursors", async () => {
    await seedSubscribers(
      currentDb,
      account.id,
      audience.id,
      Array.from({ length: 5 }, (_, i) => `page${i}@x.com`),
    );
    const base = `https://day3.app/api/v1/audiences/${audience.id}/contacts`;

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 5; i++) {
      const url: string = cursor ? `${base}?limit=2&after=${cursor}` : `${base}?limit=2`;
      const res = await contactsRoute.GET(
        v1Req(url, { key: liveKey }) as never,
        params({ audienceId: audience.id }),
      );
      const page = await body(res);
      seen.push(...page.data.map((c: Json) => c.email));
      cursor = page.next_cursor;
      if (!page.has_more) break;
    }
    expect(seen.length).toBe(5);
    expect(new Set(seen).size).toBe(5);
  });
});
