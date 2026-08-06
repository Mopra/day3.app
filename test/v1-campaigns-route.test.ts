import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { apiKeys, campaigns, type Account, type ApiKey } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { serializeScopes } from "../src/api/v1/scopes";
import type { SendEmailInput, SendEmailResult } from "../src/email/provider";
import {
  seedAccount,
  seedAudience,
  seedDomain,
  seedSender,
  seedSubscribers,
  testDb,
  TEST_EMAILS,
} from "./helpers";

// The REST twin of mcp-server.test.ts. Both front doors reach the same service
// layer, so this file concentrates on what is HTTP-specific: status codes, the
// error envelope, the body-format switch, and the editability rules.

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

vi.mock("../src/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/env")>()),
  requireUnsubscribeSecret: () => "x".repeat(32),
}));

vi.mock("../src/email/factory", () => ({
  emailProviderFromEnv: () => ({
    send: async (_input: SendEmailInput): Promise<SendEmailResult> => ({
      provider: "mock",
      messageId: "m_1",
      status: "sent",
    }),
  }),
}));

vi.mock("../src/queue/producer", () => ({
  getQueue: () => ({ send: async () => {} }),
}));

const listRoute = await import("../app/api/v1/campaigns/route");
const itemRoute = await import("../app/api/v1/campaigns/[campaignId]/route");
const previewRoute = await import("../app/api/v1/campaigns/[campaignId]/preview/route");
const sendRoute = await import("../app/api/v1/campaigns/[campaignId]/send/route");
const scheduleRoute = await import("../app/api/v1/campaigns/[campaignId]/schedule/route");

function request(url: string, method = "GET", body?: unknown): never {
  const req = new Request(`http://localhost${url}`, {
    method,
    headers: { "Content-Type": "application/json", authorization: "Bearer day3_live_test" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  // The v1 wrapper reads req.nextUrl; a plain Request needs it grafted on.
  Object.defineProperty(req, "nextUrl", { value: new URL(req.url), configurable: true });
  return req as never;
}

const params = (campaignId: string) => ({ params: Promise.resolve({ campaignId }) }) as never;

async function json(res: Response) {
  return { status: res.status, body: (await res.json()) as Record<string, never> };
}

async function seedKey(scopes: string[]): Promise<ApiKey> {
  const now = nowIso();
  const id = newId("key");
  await currentDb.insert(apiKeys).values({
    id,
    accountId: currentAccount.id,
    name: "k",
    keyHash: `hash_${id}`,
    keyPrefix: "day3_live_test",
    scopes: serializeScopes(scopes as never),
    createdBy: "user_test",
    createdAt: now,
    updatedAt: now,
  });
  return (await currentDb.query.apiKeys.findFirst({ where: eq(apiKeys.id, id) }))!;
}

async function create(body: Record<string, unknown>) {
  return json(await listRoute.POST(request("/api/v1/campaigns", "POST", body), undefined as never));
}

beforeEach(async () => {
  currentDb = await testDb();
  currentAccount = await seedAccount(currentDb);
  const domain = await seedDomain(currentDb, currentAccount.id);
  await seedSender(currentDb, currentAccount.id, domain.id, { isDefault: true });
  const audience = await seedAudience(currentDb, currentAccount.id);
  await seedSubscribers(currentDb, currentAccount.id, audience.id, TEST_EMAILS);
  currentKey = await seedKey([]);
  process.env.APP_URL = "https://app.day3.test";
});

describe("POST /v1/campaigns", () => {
  it("creates from markdown", async () => {
    const { status, body } = await create({ subject: "Hi", markdown: "# Hello\n\nBody." });
    expect(status).toBe(201);
    expect(body.object).toBe("campaign");
    expect(body.html).toContain("<h1>Hello</h1>");
    expect(body.markdown).toBe("# Hello\n\nBody.");
  });

  it("creates from raw html, sanitizing it", async () => {
    const { body } = await create({
      subject: "Hi",
      html: "<p>ok</p><script>bad()</script>",
    });
    expect(body.html).toContain("<p>ok</p>");
    expect(body.html).not.toContain("script");
    expect(body.sections).toEqual([]);
  });

  it("rejects more than one body format", async () => {
    const { status, body } = await create({ subject: "Hi", markdown: "a", html: "<p>b</p>" });
    expect(status).toBe(400);
    expect(body.error.code).toBe("invalid_request");
    expect(body.error.message).toMatch(/exactly one/);
  });

  it("names an unknown audience as the offending parameter", async () => {
    const { status, body } = await create({ subject: "Hi", audience_id: "aud_nope" });
    expect(status).toBe(404);
    expect(body.error.param).toBe("audience_id");
  });

  it("refuses a from address on a domain the account does not own", async () => {
    const { status, body } = await create({ subject: "Hi", from_email: "me@somewhere-else.com" });
    expect(status).toBe(400);
    expect(body.error.param).toBe("from_email");
  });
});

describe("GET / PATCH / DELETE /v1/campaigns/{id}", () => {
  it("returns the body in all three formats", async () => {
    const created = await create({ subject: "Hi", markdown: "Body." });
    const { body } = await json(
      await itemRoute.GET(request(`/api/v1/campaigns/${created.body.id}`), params(created.body.id)),
    );
    expect(body.markdown).toBe("Body.");
    expect(body.html).toContain("<p>Body.</p>");
    expect(Array.isArray(body.sections)).toBe(true);
  });

  it("leaves untouched fields alone on patch", async () => {
    const created = await create({ subject: "Hi", markdown: "Body." });
    const { body } = await json(
      await itemRoute.PATCH(
        request(`/api/v1/campaigns/${created.body.id}`, "PATCH", { subject: "Changed" }),
        params(created.body.id),
      ),
    );
    expect(body.subject).toBe("Changed");
    expect(body.markdown).toBe("Body.");
    expect(body.from_email).toBe("news@updates.test.co");
  });

  it("refuses to edit or delete a campaign that has left draft", async () => {
    const created = await create({ subject: "Hi", markdown: "Body." });
    await currentDb
      .update(campaigns)
      .set({ status: "sent" })
      .where(eq(campaigns.id, created.body.id));

    const patched = await json(
      await itemRoute.PATCH(
        request(`/api/v1/campaigns/${created.body.id}`, "PATCH", { subject: "No" }),
        params(created.body.id),
      ),
    );
    expect(patched.status).toBe(409);

    const deleted = await json(
      await itemRoute.DELETE(
        request(`/api/v1/campaigns/${created.body.id}`, "DELETE"),
        params(created.body.id),
      ),
    );
    expect(deleted.status).toBe(409);
  });

  it("404s an unknown campaign", async () => {
    const { status, body } = await json(
      await itemRoute.GET(request("/api/v1/campaigns/cmp_nope"), params("cmp_nope")),
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe("not_found");
  });
});

describe("GET /v1/campaigns/{id}/preview", () => {
  it("serves the rendered document as html when asked", async () => {
    const created = await create({ subject: "Hi", markdown: "Body." });
    const res = await previewRoute.GET(
      request(`/api/v1/campaigns/${created.body.id}/preview?format=html`),
      params(created.body.id),
    );
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("<html");
  });
});

describe("send scope", () => {
  it("403s an unscoped send with a code the caller can branch on", async () => {
    const created = await create({ subject: "Hi", markdown: "Body." });
    const { status, body } = await json(
      await sendRoute.POST(
        request(`/api/v1/campaigns/${created.body.id}/send`, "POST"),
        params(created.body.id),
      ),
    );
    expect(status).toBe(403);
    expect(body.error.code).toBe("insufficient_scope");
  });

  it("403s an unscoped schedule", async () => {
    const created = await create({ subject: "Hi", markdown: "Body." });
    const { status } = await json(
      await scheduleRoute.POST(
        request(`/api/v1/campaigns/${created.body.id}/schedule`, "POST", {
          send_at: new Date(Date.now() + 3_600_000).toISOString(),
        }),
        params(created.body.id),
      ),
    );
    expect(status).toBe(403);
  });

  it("accepts a scoped send and moves the campaign into review", async () => {
    currentKey = await seedKey(["campaigns:send"]);
    const created = await create({ subject: "Hi", markdown: "Body." });
    const { status, body } = await json(
      await sendRoute.POST(
        request(`/api/v1/campaigns/${created.body.id}/send`, "POST"),
        params(created.body.id),
      ),
    );
    expect(status).toBe(200);
    expect(body.status).toBe("pending_review");
  });

  it("un-schedules without needing the scope", async () => {
    currentKey = await seedKey(["campaigns:send"]);
    const created = await create({ subject: "Hi", markdown: "Body." });
    await scheduleRoute.POST(
      request(`/api/v1/campaigns/${created.body.id}/schedule`, "POST", {
        send_at: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      params(created.body.id),
    );

    currentKey = await seedKey([]);
    const { status, body } = await json(
      await scheduleRoute.DELETE(
        request(`/api/v1/campaigns/${created.body.id}/schedule`, "DELETE"),
        params(created.body.id),
      ),
    );
    expect(status).toBe(200);
    expect(body.status).toBe("draft");
    expect(body.scheduled_at).toBeNull();
  });
});
