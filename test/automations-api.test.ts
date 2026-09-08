import { beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import { automationEnrollments, automations, type Account, type ApiKey, type Audience } from "../src/db/schema";
import type { SendEmailInput, SendEmailResult } from "../src/email/provider";
import type { AutomationDetail, DraftGraphInput } from "../src/lib/automation-types";
import { newId, nowIso } from "../src/lib/ids";
import { serializeScopes, type ApiScope } from "../src/api/v1/scopes";
import { FakeQueue, seedAccount, seedAudience, seedDomain, seedSender, seedSubscribers, testDb } from "./helpers";

// The three front doors onto the automation service, driven as route handlers
// against one hermetic pglite database: the session routes under
// /api/automations, the public v1 routes, and the MCP tools. Auth for all three
// is replaced (session context, bearer-key lookup); everything below it runs
// real, including the engine's enrollment gates.

let currentDb: Db;
let currentAccount: Account;
let currentKey: ApiKey;

vi.mock("../src/api/context", () => ({
  requireAccount: async () => ({
    db: currentDb,
    account: currentAccount,
    auth: { userId: "user_test", orgId: "org_test", orgRole: "org:admin", has: () => true },
  }),
}));

vi.mock("../src/api/v1/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/v1/auth")>()),
  requireApiKey: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    if (!/^Bearer day3_live_/.test(header)) {
      const { ApiError } = await import("../src/api/v1/errors");
      throw new ApiError(401, "invalid_api_key", "Invalid API key.");
    }
    return { db: currentDb, account: currentAccount, apiKey: currentKey };
  },
}));

vi.mock("../src/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, limit: 600, remaining: 599, retryAfterSeconds: 0 }),
  enforceRateLimit: async () => {},
}));

vi.mock("../src/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/env")>()),
  requireUnsubscribeSecret: () => "x".repeat(32),
}));

let sends: SendEmailInput[] = [];
vi.mock("../src/email/factory", () => ({
  emailProviderFromEnv: () => ({
    send: async (input: SendEmailInput): Promise<SendEmailResult> => {
      sends.push(input);
      return { provider: "mock", messageId: `m_${sends.length}`, status: "sent" };
    },
  }),
}));

const queue = new FakeQueue();
vi.mock("../src/queue/producer", () => ({ getQueue: () => queue }));

const listRoute = await import("../app/api/automations/route");
const templatesRoute = await import("../app/api/automations/templates/route");
const itemRoute = await import("../app/api/automations/[id]/route");
const draftRoute = await import("../app/api/automations/[id]/draft/route");
const publishRoute = await import("../app/api/automations/[id]/publish/route");
const pauseRoute = await import("../app/api/automations/[id]/pause/route");
const resumeRoute = await import("../app/api/automations/[id]/resume/route");
const statsRoute = await import("../app/api/automations/[id]/stats/route");
const enrollmentsRoute = await import("../app/api/automations/[id]/enrollments/route");
const runNowRoute = await import("../app/api/automations/[id]/enrollments/[enrollmentId]/run-now/route");
const exitRoute = await import("../app/api/automations/[id]/enrollments/[enrollmentId]/exit/route");
const testEmailRoute = await import("../app/api/automations/[id]/nodes/[nodeKey]/test-email/route");
const v1ListRoute = await import("../app/api/v1/automations/route");
const v1EnrollRoute = await import("../app/api/v1/automations/[automationId]/enroll/route");
const mcp = await import("../app/api/mcp/route");

let audience: Audience;

function makeKey(scopes: ApiScope[]): ApiKey {
  const now = nowIso();
  return {
    id: newId("key"),
    accountId: currentAccount.id,
    name: "test key",
    keyHash: "hash",
    keyPrefix: "day3_live_test",
    scopes: serializeScopes(scopes),
    createdBy: "user_test",
    lastUsedAt: null,
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
  } as ApiKey;
}

function req(url: string, opts: { method?: string; body?: unknown; key?: string } = {}): Request {
  const r = new Request(url, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.key === undefined ? {} : { authorization: `Bearer ${opts.key}` }),
      ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  Object.defineProperty(r, "nextUrl", { value: new URL(url) });
  return r;
}

function params(values: Record<string, string>) {
  return { params: Promise.resolve(values) } as never;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
async function body(res: Response): Promise<Json> {
  return (await res.json()) as Json;
}

const BASE = "https://day3.app/api/automations";

function draftGraph(subject = "Hello", text = "Welcome to the team."): DraftGraphInput {
  return {
    nodes: [
      { key: "nd_trigger", kind: "trigger", config: {}, x: 0, y: 0 },
      {
        key: "nd_send1",
        kind: "send",
        x: 0,
        y: 150,
        config: {
          subject,
          sectionsJson: JSON.stringify([
            { id: "sec_1", kind: "text", columns: 1, content: [`<p>${text}</p>`] },
          ]),
        },
      },
      { key: "nd_end", kind: "end", config: {}, x: 0, y: 300 },
    ],
    edges: [
      { fromKey: "nd_trigger", port: "next", toKey: "nd_send1" },
      { fromKey: "nd_send1", port: "next", toKey: "nd_end" },
    ],
  };
}

async function createViaRoute(input: Record<string, unknown> = {}): Promise<AutomationDetail> {
  const res = await listRoute.POST(
    req(BASE, { method: "POST", body: { name: "Welcome", audienceId: audience.id, ...input } }) as never,
    params({}),
  );
  expect(res.status).toBe(201);
  return (await body(res)) as AutomationDetail;
}

async function publishedViaRoutes(): Promise<AutomationDetail> {
  const created = await createViaRoute();
  const saved = await draftRoute.PUT(
    req(`${BASE}/${created.id}/draft`, { method: "PUT", body: draftGraph() }) as never,
    params({ id: created.id }),
  );
  expect(saved.status).toBe(200);
  const published = await publishRoute.POST(req(`${BASE}/${created.id}/publish`, { method: "POST" }) as never, params({ id: created.id }));
  expect(published.status).toBe(200);
  return (await body(published)) as AutomationDetail;
}

beforeEach(async () => {
  currentDb = await testDb();
  queue.messages.length = 0;
  sends = [];
  delete process.env.AI_REVIEW_MODE;
  process.env.APP_URL = "https://app.day3.test";
  currentAccount = await seedAccount(currentDb);
  const domain = await seedDomain(currentDb, currentAccount.id);
  await seedSender(currentDb, currentAccount.id, domain.id, { isDefault: true });
  audience = await seedAudience(currentDb, currentAccount.id);
  await seedSubscribers(currentDb, currentAccount.id, audience.id, ["alice@example.com"]);
  currentKey = makeKey([]);
});

describe("session routes: lifecycle", () => {
  it("lists templates, creates from one, reads, patches, lists and archives", async () => {
    const templates = await body(await templatesRoute.GET(req(`${BASE}/templates`) as never, params({})));
    expect(templates.map((t: { key: string }) => t.key)).toContain("trial-onboarding");

    const created = await createViaRoute({ templateKey: "trial-onboarding" });
    expect(created.draft.nodes).toHaveLength(7);
    expect(created.status).toBe("draft");

    const read = await body(await itemRoute.GET(req(`${BASE}/${created.id}`) as never, params({ id: created.id })));
    expect(read.id).toBe(created.id);
    expect(read.validation.ok).toBe(true);

    const patched = await itemRoute.PATCH(
      req(`${BASE}/${created.id}`, { method: "PATCH", body: { name: "Onboarding", reentry: "once_at_a_time" } }) as never,
      params({ id: created.id }),
    );
    expect(patched.status).toBe(200);
    expect((await body(patched)).name).toBe("Onboarding");

    const bad = await itemRoute.PATCH(
      req(`${BASE}/${created.id}`, { method: "PATCH", body: { timezone: "Nowhere/Land" } }) as never,
      params({ id: created.id }),
    );
    expect(bad.status).toBe(400);

    const list = await body(await listRoute.GET(req(BASE) as never, params({})));
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      id: created.id,
      name: "Onboarding",
      audienceName: "Test audience",
      liveVersion: null,
      counts: { total: 0 },
    });

    const deleted = await itemRoute.DELETE(req(`${BASE}/${created.id}`, { method: "DELETE" }) as never, params({ id: created.id }));
    expect(await body(deleted)).toEqual({ ok: true });
    expect((await itemRoute.GET(req(`${BASE}/${created.id}`) as never, params({ id: created.id }))).status).toBe(404);
  });

  it("returns 422 with the offending nodes when publish is blocked, 200 with the detail when it passes", async () => {
    const created = await createViaRoute();
    // A lone trigger and no email: the graph is fine but there is nothing to send.
    // Give it a send node with no content instead so a node is named.
    await draftRoute.PUT(
      req(`${BASE}/${created.id}/draft`, {
        method: "PUT",
        body: {
          nodes: [
            { key: "nd_trigger", kind: "trigger", config: {}, x: 0, y: 0 },
            { key: "nd_send1", kind: "send", config: { subject: "" }, x: 0, y: 100 },
          ],
          edges: [{ fromKey: "nd_trigger", port: "next", toKey: "nd_send1" }],
        },
      }) as never,
      params({ id: created.id }),
    );
    const blocked = await publishRoute.POST(req(`${BASE}/${created.id}/publish`, { method: "POST" }) as never, params({ id: created.id }));
    expect(blocked.status).toBe(422);
    const failure = await body(blocked);
    expect(failure.error).toMatch(/Fix the issues/);
    expect(failure.validation.errors.some((e: { nodeKey?: string }) => e.nodeKey === "nd_send1")).toBe(true);

    const detail = await publishedViaRoutes();
    expect(detail.status).toBe("active");
    expect(detail.liveVersion?.version).toBe(1);
    expect(detail.draftDirty).toBe(false);
  });

  it("rejects an oversized or malformed draft at the schema", async () => {
    const created = await createViaRoute();
    const tooMany = await draftRoute.PUT(
      req(`${BASE}/${created.id}/draft`, {
        method: "PUT",
        body: {
          nodes: Array.from({ length: 101 }, (_, i) => ({ key: `nd_n${i}`, kind: "end", config: {}, x: 0, y: 0 })),
          edges: [],
        },
      }) as never,
      params({ id: created.id }),
    );
    expect(tooMany.status).toBe(400);

    const badKey = await draftRoute.PUT(
      req(`${BASE}/${created.id}/draft`, {
        method: "PUT",
        body: { nodes: [{ key: "node-1", kind: "trigger", config: {}, x: 0, y: 0 }], edges: [] },
      }) as never,
      params({ id: created.id }),
    );
    expect(badKey.status).toBe(400);
  });

  it("pauses, resumes, reports stats and manages enrollments", async () => {
    const detail = await publishedViaRoutes();

    const enrolled = await enrollmentsRoute.POST(
      req(`${BASE}/${detail.id}/enrollments`, { method: "POST", body: { email: "alice@example.com" } }) as never,
      params({ id: detail.id }),
    );
    expect(enrolled.status).toBe(200);
    const result = await body(enrolled);
    expect(result.outcome).toBe("enrolled");
    expect(queue.messages).toHaveLength(1);

    const missing = await body(
      await enrollmentsRoute.POST(
        req(`${BASE}/${detail.id}/enrollments`, { method: "POST", body: { email: "ghost@example.com" } }) as never,
        params({ id: detail.id }),
      ),
    );
    expect(missing.outcome).toBe("not_subscribed");

    const page = await body(
      await enrollmentsRoute.GET(req(`${BASE}/${detail.id}/enrollments?status=active&limit=10`) as never, params({ id: detail.id })),
    );
    expect(page.total).toBe(1);
    expect(page.rows[0].email).toBe("alice@example.com");
    expect(
      (await enrollmentsRoute.GET(req(`${BASE}/${detail.id}/enrollments?status=bogus`) as never, params({ id: detail.id }))).status,
    ).toBe(400);

    const stats = await body(await statsRoute.GET(req(`${BASE}/${detail.id}/stats`) as never, params({ id: detail.id })));
    expect(stats.counts.active).toBe(1);
    expect(stats.nodes.find((n: { nodeKey: string }) => n.nodeKey === "nd_trigger").waiting).toBe(1);

    queue.messages.length = 0;
    const ran = await runNowRoute.POST(
      req(`${BASE}/${detail.id}/enrollments/${result.enrollment_id ?? result.enrollmentId}/run-now`, { method: "POST" }) as never,
      params({ id: detail.id, enrollmentId: result.enrollmentId }),
    );
    expect(await body(ran)).toEqual({ ok: true });
    expect(queue.messages[0]).toMatchObject({ type: "advance_automation_enrollment", enrollmentId: result.enrollmentId });

    const exited = await exitRoute.POST(
      req(`${BASE}/${detail.id}/enrollments/${result.enrollmentId}/exit`, { method: "POST" }) as never,
      params({ id: detail.id, enrollmentId: result.enrollmentId }),
    );
    expect(await body(exited)).toEqual({ ok: true });
    const row = await currentDb.query.automationEnrollments.findFirst({
      where: eq(automationEnrollments.id, result.enrollmentId),
    });
    expect(row?.status).toBe("exited");

    const paused = await body(await pauseRoute.POST(req(`${BASE}/${detail.id}/pause`, { method: "POST" }) as never, params({ id: detail.id })));
    expect(paused.status).toBe("paused");
    // A paused automation refuses new enrollments at the gate.
    const refused = await body(
      await enrollmentsRoute.POST(
        req(`${BASE}/${detail.id}/enrollments`, { method: "POST", body: { email: "alice@example.com" } }) as never,
        params({ id: detail.id }),
      ),
    );
    expect(refused.outcome).toBe("automation_not_active");
    const resumed = await body(await resumeRoute.POST(req(`${BASE}/${detail.id}/resume`, { method: "POST" }) as never, params({ id: detail.id })));
    expect(resumed.status).toBe("active");
  });

  it("sends a test of one step through the campaign test path", async () => {
    const detail = await publishedViaRoutes();
    const res = await testEmailRoute.POST(
      req(`${BASE}/${detail.id}/nodes/nd_send1/test-email`, { method: "POST", body: { to: ["me@example.com"] } }) as never,
      params({ id: detail.id, nodeKey: "nd_send1" }),
    );
    expect(res.status).toBe(200);
    expect(await body(res)).toEqual({ ok: true, sent: ["me@example.com"], failed: [] });
    expect(sends[0].subject).toBe("[Test] Hello");

    const tooMany = await testEmailRoute.POST(
      req(`${BASE}/${detail.id}/nodes/nd_send1/test-email`, {
        method: "POST",
        body: { to: ["a@x.com", "b@x.com", "c@x.com", "d@x.com", "e@x.com", "f@x.com"] },
      }) as never,
      params({ id: detail.id, nodeKey: "nd_send1" }),
    );
    expect(tooMany.status).toBe(400);
  });

  it("never shows another account's automation", async () => {
    const detail = await publishedViaRoutes();
    const owner = currentAccount;
    currentAccount = await seedAccount(currentDb);
    expect((await itemRoute.GET(req(`${BASE}/${detail.id}`) as never, params({ id: detail.id }))).status).toBe(404);
    expect((await pauseRoute.POST(req(`${BASE}/${detail.id}/pause`, { method: "POST" }) as never, params({ id: detail.id }))).status).toBe(404);
    expect(await body(await listRoute.GET(req(BASE) as never, params({})))).toEqual([]);
    currentAccount = owner;
    const row = await currentDb.query.automations.findFirst({ where: eq(automations.id, detail.id) });
    expect(row?.status).toBe("active");
  });
});

describe("v1 routes", () => {
  const V1 = "https://day3.app/api/v1/automations";

  it("lists automations without a scope, hiding archived ones by default", async () => {
    const live = await publishedViaRoutes();
    const draft = await createViaRoute({ name: "Draft" });
    const gone = await createViaRoute({ name: "Gone" });
    await draftRoute.PUT(req(`${BASE}/${gone.id}/draft`, { method: "PUT", body: draftGraph() }) as never, params({ id: gone.id }));
    await publishRoute.POST(req(`${BASE}/${gone.id}/publish`, { method: "POST" }) as never, params({ id: gone.id }));
    await itemRoute.DELETE(req(`${BASE}/${gone.id}`, { method: "DELETE" }) as never, params({ id: gone.id }));

    let res = await v1ListRoute.GET(req(V1, { key: "day3_live_test" }) as never, params({}));
    expect(res.status).toBe(200);
    let page = await body(res);
    expect(page.data.map((a: { id: string }) => a.id).sort()).toEqual([draft.id, live.id].sort());
    const liveRow = page.data.find((a: { id: string }) => a.id === live.id);
    expect(liveRow).toMatchObject({
      object: "automation",
      name: "Welcome",
      status: "active",
      trigger: "audience_join",
      audience_id: audience.id,
      live_version: 1,
      sandbox: false,
    });
    expect(liveRow.created_at).toMatch(/Z$/);

    res = await v1ListRoute.GET(req(`${V1}?status=archived`, { key: "day3_live_test" }) as never, params({}));
    page = await body(res);
    expect(page.data.map((a: { id: string }) => a.id)).toEqual([gone.id]);

    res = await v1ListRoute.GET(req(`${V1}?limit=1`, { key: "day3_live_test" }) as never, params({}));
    page = await body(res);
    expect(page.data).toHaveLength(1);
    expect(page.has_more).toBe(true);
    expect(page.next_cursor).toBeTruthy();

    expect((await v1ListRoute.GET(req(V1) as never, params({}))).status).toBe(401);
    expect((await v1ListRoute.GET(req(`${V1}?status=weird`, { key: "day3_live_test" }) as never, params({}))).status).toBe(400);
  });

  it("gates enroll on the automations:enroll scope and names the fix", async () => {
    const live = await publishedViaRoutes();
    const res = await v1EnrollRoute.POST(
      req(`${V1}/${live.id}/enroll`, { method: "POST", key: "day3_live_test", body: { email: "alice@example.com" } }) as never,
      params({ automationId: live.id }),
    );
    expect(res.status).toBe(403);
    const err = await body(res);
    expect(err.error.code).toBe("insufficient_scope");
    expect(err.error.message).toMatch(/automations:enroll/);
    expect(err.error.message).toMatch(/API keys/);
    expect(await currentDb.select().from(automationEnrollments)).toEqual([]);

    // campaigns:send is not enough: enrolling is its own grant.
    currentKey = makeKey(["campaigns:send"]);
    expect(
      (
        await v1EnrollRoute.POST(
          req(`${V1}/${live.id}/enroll`, { method: "POST", key: "day3_live_test", body: { email: "alice@example.com" } }) as never,
          params({ automationId: live.id }),
        )
      ).status,
    ).toBe(403);
  });

  it("enrolls, creates the contact when attributes are given, and replays under an Idempotency-Key", async () => {
    currentKey = makeKey(["automations:enroll"]);
    const live = await publishedViaRoutes();

    let res = await v1EnrollRoute.POST(
      req(`${V1}/${live.id}/enroll`, { method: "POST", key: "day3_live_test", body: { email: "alice@example.com" } }) as never,
      params({ automationId: live.id }),
    );
    expect(res.status).toBe(200);
    const first = await body(res);
    expect(first).toMatchObject({ object: "enrollment_result", outcome: "enrolled" });
    expect(first.enrollment_id).toMatch(/^aen_/);

    // Missing contact, no attributes: reported, not created.
    res = await v1EnrollRoute.POST(
      req(`${V1}/${live.id}/enroll`, { method: "POST", key: "day3_live_test", body: { email: "trial@acme.com" } }) as never,
      params({ automationId: live.id }),
    );
    expect(await body(res)).toEqual({ object: "enrollment_result", outcome: "not_subscribed", enrollment_id: null });

    // With attributes: created as subscribed, then enrolled.
    const idem = new Request(`${V1}/${live.id}/enroll`, {
      method: "POST",
      headers: {
        authorization: "Bearer day3_live_test",
        "content-type": "application/json",
        "idempotency-key": "trial-started-42",
      },
      body: JSON.stringify({ email: "trial@acme.com", attributes: { trial_ends: "2026-10-01" } }),
    });
    Object.defineProperty(idem, "nextUrl", { value: new URL(`${V1}/${live.id}/enroll`) });
    res = await v1EnrollRoute.POST(idem.clone() as never, params({ automationId: live.id }));
    expect(res.status).toBe(200);
    const enrolled = await body(res);
    expect(enrolled.outcome).toBe("enrolled");
    const contact = await currentDb.query.subscribers.findFirst({
      where: (t, { eq: e }) => e(t.email, "trial@acme.com"),
    });
    expect(contact?.status).toBe("subscribed");
    expect(contact?.attributes).toEqual({ trial_ends: "2026-10-01" });

    // Same key again: the stored response, not a second re-entry evaluation.
    res = await v1EnrollRoute.POST(idem.clone() as never, params({ automationId: live.id }));
    expect(res.headers.get("Idempotency-Replayed")).toBe("true");
    expect(await body(res)).toEqual(enrolled);

    // Without the key, re-entry `once` reports already_enrolled.
    res = await v1EnrollRoute.POST(
      req(`${V1}/${live.id}/enroll`, { method: "POST", key: "day3_live_test", body: { email: "trial@acme.com" } }) as never,
      params({ automationId: live.id }),
    );
    expect((await body(res)).outcome).toBe("already_enrolled");

    // Not active → 409; unknown → 404; bad email → 400.
    await pauseRoute.POST(req(`${BASE}/${live.id}/pause`, { method: "POST" }) as never, params({ id: live.id }));
    res = await v1EnrollRoute.POST(
      req(`${V1}/${live.id}/enroll`, { method: "POST", key: "day3_live_test", body: { email: "alice@example.com" } }) as never,
      params({ automationId: live.id }),
    );
    expect(res.status).toBe(409);
    expect((await body(res)).error.message).toMatch(/paused/);
    res = await v1EnrollRoute.POST(
      req(`${V1}/aut_nope/enroll`, { method: "POST", key: "day3_live_test", body: { email: "alice@example.com" } }) as never,
      params({ automationId: "aut_nope" }),
    );
    expect(res.status).toBe(404);
    expect((await body(res)).error.code).toBe("not_found");
    await resumeRoute.POST(req(`${BASE}/${live.id}/resume`, { method: "POST" }) as never, params({ id: live.id }));
    res = await v1EnrollRoute.POST(
      req(`${V1}/${live.id}/enroll`, { method: "POST", key: "day3_live_test", body: { email: "nope" } }) as never,
      params({ automationId: live.id }),
    );
    expect(res.status).toBe(400);
    expect((await body(res)).error.code).toBe("invalid_email");
  });

  it("refuses to enroll into another account's automation", async () => {
    currentKey = makeKey(["automations:enroll"]);
    const live = await publishedViaRoutes();
    currentAccount = await seedAccount(currentDb);
    currentKey = makeKey(["automations:enroll"]);
    const res = await v1EnrollRoute.POST(
      req(`${V1}/${live.id}/enroll`, { method: "POST", key: "day3_live_test", body: { email: "alice@example.com" } }) as never,
      params({ automationId: live.id }),
    );
    expect(res.status).toBe(404);
  });
});

describe("MCP tools", () => {
  let rpcId = 0;
  async function rpc(method: string, params?: unknown) {
    const res = await mcp.POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: "Bearer day3_live_test" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
      }) as never,
    );
    return (await res.json()) as Json;
  }
  async function tool(name: string, args: Record<string, unknown> = {}) {
    const { result } = await rpc("tools/call", { name, arguments: args });
    const text = result.content[0]?.text ?? "";
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    return { isError: result.isError === true, text, data: data as Json };
  }

  it("advertises both tools and marks enrolling as the one that mails people", async () => {
    const { result } = await rpc("tools/list");
    const tools = result.tools as { name: string; annotations?: { destructiveHint?: boolean; readOnlyHint?: boolean } }[];
    const names = tools.map((t) => t.name);
    expect(names).toContain("day3_list_automations");
    expect(names).toContain("day3_enroll_in_automation");
    expect(tools.find((t) => t.name === "day3_list_automations")!.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === "day3_enroll_in_automation")!.annotations?.destructiveHint).toBe(true);
    const init = await rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(init.result.instructions).toContain("automations:enroll");
  });

  it("lists through the same serializer as v1 and enrolls only with the scope", async () => {
    const live = await publishedViaRoutes();
    const list = await tool("day3_list_automations");
    expect(list.isError).toBe(false);
    expect(list.data.automations).toHaveLength(1);
    expect(list.data.automations[0]).toMatchObject({ id: live.id, object: "automation", live_version: 1 });
    // A typo in the filter is an error here exactly as it is on GET /v1/automations,
    // not a silently empty list the model would read as "no automations".
    const typo = await tool("day3_list_automations", { status: "weird" });
    expect(typo.isError).toBe(true);
    expect(typo.text).toMatch(/Unknown status/);

    const ctx = await tool("day3_context");
    expect(ctx.data.api_key.can_enroll_in_automations).toBe(false);

    const denied = await tool("day3_enroll_in_automation", { automation_id: live.id, email: "alice@example.com" });
    expect(denied.isError).toBe(true);
    expect(denied.text).toMatch(/automations:enroll/);

    currentKey = makeKey(["automations:enroll"]);
    const ok = await tool("day3_enroll_in_automation", {
      automation_id: live.id,
      email: "alice@example.com",
      attributes: { plan: "trial" },
    });
    expect(ok.isError).toBe(false);
    expect(ok.data).toMatchObject({ automation_id: live.id, outcome: "enrolled" });
    expect(ok.data.enrollment_id).toMatch(/^aen_/);

    const bad = await tool("day3_enroll_in_automation", {
      automation_id: live.id,
      email: "bob@example.com",
      attributes: { count: 5 },
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/must be a string/);
  });
});
