import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { apiKeys, webhookDeliveries, webhookEndpoints, type Account, type ApiKey } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { serializeScopes } from "../src/api/v1/scopes";
import { emitWebhookEvent } from "../src/services/webhook-events";
import { seedAccount, testDb } from "./helpers";

// The public-API front door for webhook endpoints. What matters here is the
// gate: `webhooks:manage` is required on every route including the reads,
// because an endpoint is a standing feed of every address the account mails.

let currentDb: Db;
let currentAccount: Account;
let currentKey: ApiKey;

vi.mock("../src/api/v1/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/v1/auth")>()),
  requireApiKey: async () => ({ db: currentDb, account: currentAccount, apiKey: currentKey }),
}));

vi.mock("../src/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, limit: 100, remaining: 99, retryAfterSeconds: 0 }),
  enforceRateLimit: async () => {},
}));

vi.mock("../src/queue/producer", () => ({
  getQueue: () => ({ send: async () => {} }),
}));

const listRoute = await import("../app/api/v1/webhooks/route");
const detailRoute = await import("../app/api/v1/webhooks/[webhookId]/route");
const deliveriesRoute = await import("../app/api/v1/webhooks/[webhookId]/deliveries/route");

const ENC_KEY = Buffer.alloc(32, 5).toString("base64");

function req(url: string, opts: { method?: string; body?: unknown } = {}): Request {
  const r = new Request(url, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  // Route handlers read query strings through NextRequest's `nextUrl`.
  Object.defineProperty(r, "nextUrl", { value: new URL(url) });
  return r;
}
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });
const body = async (res: Response) => res.json() as Promise<Record<string, never>>;

async function seedKey(accountId: string, scopes: string[]): Promise<ApiKey> {
  const now = nowIso();
  const id = newId("key");
  await currentDb.insert(apiKeys).values({
    id,
    accountId,
    name: "test",
    keyHash: `hash_${id}`,
    keyPrefix: "day3_live_x",
    scopes: serializeScopes(scopes as never),
    createdBy: "user_test",
    createdAt: now,
    updatedAt: now,
  });
  return (await currentDb.query.apiKeys.findFirst({ where: eq(apiKeys.id, id) }))!;
}

beforeEach(async () => {
  process.env.DNS_TOKEN_ENC_KEY = ENC_KEY;
  currentDb = await testDb();
  currentAccount = await seedAccount(currentDb);
  currentKey = await seedKey(currentAccount.id, ["webhooks:manage"]);
});
afterEach(() => {
  delete process.env.DNS_TOKEN_ENC_KEY;
});

describe("v1 webhooks", () => {
  it("requires the webhooks:manage scope on reads and writes alike", async () => {
    currentKey = await seedKey(currentAccount.id, []);
    const url = "https://day3.app/api/v1/webhooks";

    for (const res of [
      await listRoute.GET(req(url) as never, params({})),
      await listRoute.POST(
        req(url, { method: "POST", body: { url: "https://a.example.com/h", events: ["email.bounced"] } }) as never,
        params({}),
      ),
      await detailRoute.GET(req(`${url}/whe_1`) as never, params({ webhookId: "whe_1" })),
      await detailRoute.DELETE(req(`${url}/whe_1`, { method: "DELETE" }) as never, params({ webhookId: "whe_1" })),
      await deliveriesRoute.GET(req(`${url}/whe_1/deliveries`) as never, params({ webhookId: "whe_1" })),
    ]) {
      expect(res.status).toBe(403);
      expect((await body(res)).error.code).toBe("insufficient_scope");
    }
    // A key with only the send scope is still refused — scopes don't imply.
    currentKey = await seedKey(currentAccount.id, ["campaigns:send"]);
    expect((await listRoute.GET(req(url) as never, params({}))).status).toBe(403);
  });

  it("creates an endpoint and returns the signing secret exactly once", async () => {
    const res = await listRoute.POST(
      req("https://day3.app/api/v1/webhooks", {
        method: "POST",
        body: {
          url: "https://exit1.dev/webhooks/day3",
          description: "prod",
          events: ["email.bounced", "suppression.created"],
        },
      }) as never,
      params({}),
    );
    expect(res.status).toBe(201);
    const created = await body(res);
    expect(created).toMatchObject({
      object: "webhook_endpoint",
      url: "https://exit1.dev/webhooks/day3",
      status: "enabled",
    });
    expect(String(created.secret).startsWith("whsec_")).toBe(true);

    // …and never again: neither the list nor the detail read exposes it.
    // (Status asserted first — a 500 body also happens not to contain the
    // secret, which would make these checks pass for the wrong reason.)
    const listRes = await listRoute.GET(req("https://day3.app/api/v1/webhooks") as never, params({}));
    expect(listRes.status).toBe(200);
    const list = await body(listRes);
    expect((list as unknown as { data: unknown[] }).data).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("whsec_");

    const detailRes = await detailRoute.GET(
      req("https://day3.app/api/v1/webhooks/x") as never,
      params({ webhookId: String(created.id) }),
    );
    expect(detailRes.status).toBe(200);
    const detail = await body(detailRes);
    expect(JSON.stringify(detail)).not.toContain("whsec_");
    expect(detail).not.toHaveProperty("secret_enc");
  });

  it("rejects a non-public URL with a 400 naming the param", async () => {
    const res = await listRoute.POST(
      req("https://day3.app/api/v1/webhooks", {
        method: "POST",
        body: { url: "http://169.254.169.254/latest/meta-data/", events: ["email.bounced"] },
      }) as never,
      params({}),
    );
    expect(res.status).toBe(400);
    const err = (await body(res)).error as unknown as { code: string; param?: string };
    expect(err.code).toBe("invalid_request");
    expect(err.param).toBe("url");
  });

  it("patches events and status, and 404s across a tenant boundary", async () => {
    const created = await body(
      await listRoute.POST(
        req("https://day3.app/api/v1/webhooks", {
          method: "POST",
          body: { url: "https://a.example.com/h", events: ["email.bounced"] },
        }) as never,
        params({}),
      ),
    );
    const id = String(created.id);

    const patched = await body(
      await detailRoute.PATCH(
        req(`https://day3.app/api/v1/webhooks/${id}`, {
          method: "PATCH",
          body: { events: ["email.delivered", "suppression.created"], status: "disabled" },
        }) as never,
        params({ webhookId: id }),
      ),
    );
    expect(patched).toMatchObject({ status: "disabled" });
    expect(patched.events).toEqual(["email.delivered", "suppression.created"]);

    // Another account's key must not see or touch it.
    const other = await seedAccount(currentDb);
    currentAccount = other;
    currentKey = await seedKey(other.id, ["webhooks:manage"]);
    expect(
      (await detailRoute.GET(req("https://day3.app/api/v1/webhooks/x") as never, params({ webhookId: id }))).status,
    ).toBe(404);
    expect(
      (
        await detailRoute.DELETE(
          req("https://day3.app/api/v1/webhooks/x", { method: "DELETE" }) as never,
          params({ webhookId: id }),
        )
      ).status,
    ).toBe(404);
  });

  it("lists deliveries without leaking the signed payload, and filters by status", async () => {
    const now = nowIso();
    const endpointId = newId("whe");
    await currentDb.insert(webhookEndpoints).values({
      id: endpointId,
      accountId: currentAccount.id,
      url: "https://a.example.com/h",
      enabledEvents: ["suppression.created"],
      secretEnc: "unused",
      createdBy: "usr",
      createdAt: now,
      updatedAt: now,
    });
    await emitWebhookEvent(currentDb, {
      type: "suppression.created",
      accountId: currentAccount.id,
      eventId: "evt_1",
      email: "secret-recipient@example.com",
      reason: "hard_bounce",
      source: "test",
    });

    const res = await deliveriesRoute.GET(
      req(`https://day3.app/api/v1/webhooks/${endpointId}/deliveries`) as never,
      params({ webhookId: endpointId }),
    );
    expect(res.status).toBe(200);
    const page = await body(res);
    const raw = JSON.stringify(page);
    expect(raw).toContain("webhook_delivery");
    // The payload — and so the recipient address — is not in the API response.
    expect(raw).not.toContain("secret-recipient@example.com");
    expect(raw).not.toContain("payload");

    // Status filter is validated against the known set.
    const bad = await deliveriesRoute.GET(
      req(`https://day3.app/api/v1/webhooks/${endpointId}/deliveries?status=nonsense`) as never,
      params({ webhookId: endpointId }),
    );
    expect(bad.status).toBe(400);

    const filtered = await body(
      await deliveriesRoute.GET(
        req(`https://day3.app/api/v1/webhooks/${endpointId}/deliveries?status=succeeded`) as never,
        params({ webhookId: endpointId }),
      ),
    );
    expect((filtered as unknown as { data: unknown[] }).data).toHaveLength(0);
  });

  it("404s the delivery log for an endpoint that isn't yours", async () => {
    const other = await seedAccount(currentDb);
    const now = nowIso();
    const foreignId = newId("whe");
    await currentDb.insert(webhookEndpoints).values({
      id: foreignId,
      accountId: other.id,
      url: "https://b.example.com/h",
      enabledEvents: ["email.bounced"],
      secretEnc: "unused",
      createdBy: "usr",
      createdAt: now,
      updatedAt: now,
    });

    const res = await deliveriesRoute.GET(
      req(`https://day3.app/api/v1/webhooks/${foreignId}/deliveries`) as never,
      params({ webhookId: foreignId }),
    );
    expect(res.status).toBe(404);
  });

  it("deleting over the API removes the endpoint's deliveries too", async () => {
    const created = await body(
      await listRoute.POST(
        req("https://day3.app/api/v1/webhooks", {
          method: "POST",
          body: { url: "https://a.example.com/h", events: ["suppression.created"] },
        }) as never,
        params({}),
      ),
    );
    const id = String(created.id);
    await emitWebhookEvent(currentDb, {
      type: "suppression.created",
      accountId: currentAccount.id,
      eventId: "evt_del",
      email: "a@b.com",
      reason: "manual",
      source: "test",
    });
    expect(await currentDb.select().from(webhookDeliveries)).toHaveLength(1);

    const res = await detailRoute.DELETE(
      req("https://day3.app/api/v1/webhooks/x", { method: "DELETE" }) as never,
      params({ webhookId: id }),
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toMatchObject({ deleted: true });
    expect(await currentDb.select().from(webhookDeliveries)).toHaveLength(0);
  });
});
