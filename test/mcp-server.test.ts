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

// Drives the MCP endpoint end to end against a hermetic pglite database: the
// real protocol handler, the real tools, the real v1 service layer. Only the
// three seams that reach outside the process — key lookup, rate limiting, the
// email provider and the job queue — are replaced.

let currentDb: Db;
let currentAccount: Account;
let currentKey: ApiKey;

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
  checkRateLimit: async () => ({ allowed: true, limit: 100, remaining: 99, retryAfterSeconds: 0 }),
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

let queued: unknown[] = [];
vi.mock("../src/queue/producer", () => ({
  getQueue: () => ({
    send: async (message: unknown) => {
      queued.push(message);
    },
  }),
}));

const mcp = await import("../app/api/mcp/route");

let rpcId = 0;

async function rpc(method: string, params?: unknown, auth = "Bearer day3_live_test") {
  const res = await mcp.POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: auth },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    }) as never,
  );
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

// Call a tool and parse the JSON its text content carries.
async function tool(name: string, args: Record<string, unknown> = {}) {
  const { body } = await rpc("tools/call", { name, arguments: args });
  const result = body.result as { content: { text: string }[]; isError?: boolean };
  const text = result.content[0]?.text ?? "";
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { isError: result.isError === true, text, data: parsed as Record<string, unknown> };
}

async function seedKey(db: Db, accountId: string, scopes: string[]): Promise<ApiKey> {
  const now = nowIso();
  const id = newId("key");
  await db.insert(apiKeys).values({
    id,
    accountId,
    name: "test key",
    keyHash: `hash_${id}`,
    keyPrefix: "day3_live_test",
    scopes: serializeScopes(scopes as never),
    createdBy: "user_test",
    createdAt: now,
    updatedAt: now,
  });
  return (await db.query.apiKeys.findFirst({ where: eq(apiKeys.id, id) }))!;
}

let audienceId: string;

beforeEach(async () => {
  sends = [];
  queued = [];
  currentDb = await testDb();
  currentAccount = await seedAccount(currentDb);
  const domain = await seedDomain(currentDb, currentAccount.id);
  await seedSender(currentDb, currentAccount.id, domain.id, { isDefault: true });
  const audience = await seedAudience(currentDb, currentAccount.id);
  audienceId = audience.id;
  await seedSubscribers(currentDb, currentAccount.id, audience.id, TEST_EMAILS);
  currentKey = await seedKey(currentDb, currentAccount.id, []);
  process.env.APP_URL = "https://app.day3.test";
});

describe("MCP protocol", () => {
  it("refuses an unauthenticated request, including tool discovery", async () => {
    const res = await rpc("tools/list", undefined, "");
    expect(res.status).toBe(401);
    expect(res.body.error.message).toMatch(/api key/i);
  });

  it("initializes and advertises tools", async () => {
    const { body } = await rpc("initialize", { protocolVersion: "2025-06-18" });
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.serverInfo.name).toBe("day3");
    expect(body.result.instructions).toContain("Day3 Markdown");
  });

  it("echoes a protocol version it was not written against", async () => {
    const { body } = await rpc("initialize", { protocolVersion: "2099-01-01" });
    expect(body.result.protocolVersion).toBe("2099-01-01");
  });

  it("lists every tool with a schema", async () => {
    const { body } = await rpc("tools/list");
    const tools = body.result.tools as { name: string; inputSchema: unknown }[];
    expect(tools.map((t) => t.name)).toContain("day3_create_campaign");
    expect(tools.every((t) => t.inputSchema)).toBe(true);
    // The two that put email in inboxes must say so to the client.
    const send = tools.find((t) => t.name === "day3_send_campaign") as {
      annotations?: { destructiveHint?: boolean };
    };
    expect(send.annotations?.destructiveHint).toBe(true);
  });

  it("answers ping and swallows notifications", async () => {
    expect((await rpc("ping")).body.result).toEqual({});
    const res = await mcp.POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", authorization: "Bearer day3_live_test" },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      }) as never,
    );
    expect(res.status).toBe(202);
  });

  it("reports an unknown method as a JSON-RPC error", async () => {
    const { body } = await rpc("resources/list");
    expect(body.error.code).toBe(-32601);
  });

  it("declines to open an event stream", async () => {
    expect(mcp.GET().status).toBe(405);
  });
});

describe("MCP tools", () => {
  it("reports workspace context", async () => {
    const { data } = await tool("day3_context");
    expect((data.workspace as Record<string, unknown>).can_send).toBe(true);
    expect((data.api_key as Record<string, unknown>).can_send_campaigns).toBe(false);
    expect((data.audiences as unknown[])).toHaveLength(1);
    expect((data.senders as unknown[])).toHaveLength(1);
  });

  it("creates a campaign from markdown and returns a link to it", async () => {
    const { data } = await tool("day3_create_campaign", {
      subject: "Launch day",
      markdown: "# We shipped\n\nRead the [post](https://day3.app/blog).\n\n[Get started](https://day3.app){.button}",
    });
    expect(data.id).toMatch(/^cmp_/);
    expect(data.status).toBe("draft");
    expect(data.url).toBe(`https://app.day3.test/campaigns/${data.id}`);
    // Defaults were resolved rather than demanded.
    expect(data.audience_id).toBe(audienceId);
    expect(data.from_email).toBe("news@updates.test.co");
    // The body landed as real builder sections, not one HTML blob.
    const sections = data.sections as { kind: string }[];
    expect(sections.map((s) => s.kind)).toEqual(["text", "button"]);
    expect(data.html).toContain("<h1>We shipped</h1>");
  });

  it("round-trips a body through get and update", async () => {
    const created = await tool("day3_create_campaign", {
      subject: "Hello",
      markdown: "First draft.",
    });
    const fetched = await tool("day3_get_campaign", { campaign_id: created.data.id });
    expect(fetched.data.markdown).toBe("First draft.");

    const updated = await tool("day3_update_campaign", {
      campaign_id: created.data.id,
      markdown: "## Second draft\n\nBetter.",
      subject: "Hello again",
    });
    expect(updated.data.subject).toBe("Hello again");
    expect(updated.data.markdown).toBe("## Second draft\n\nBetter.");
    // An untouched field is left alone.
    expect(updated.data.audience_id).toBe(audienceId);
  });

  it("previews the rendered email with the compliance footer", async () => {
    const created = await tool("day3_create_campaign", {
      subject: "Hi {{first_name|there}}",
      markdown: "Body copy.",
    });
    const { data } = await tool("day3_preview_campaign", { campaign_id: created.data.id });
    expect(data.subject).toBe("Hi Alex");
    expect(data.text).toContain("Body copy.");
    expect(data.html).toBeUndefined();
    expect(Number(data.html_bytes)).toBeGreaterThan(0);

    const withHtml = await tool("day3_preview_campaign", {
      campaign_id: created.data.id,
      include_html: true,
    });
    expect(String(withHtml.data.html)).toContain("123 Test St");
  });

  it("sends a test email without needing the send scope", async () => {
    const created = await tool("day3_create_campaign", {
      subject: "Check this",
      markdown: "Body copy.",
    });
    const { isError, data } = await tool("day3_send_test", {
      campaign_id: created.data.id,
      to: ["me@example.com"],
    });
    expect(isError).toBe(false);
    expect(data.sent).toEqual(["me@example.com"]);
    expect(sends).toHaveLength(1);
    expect(sends[0].subject).toBe("[Test] Check this");
  });
});

describe("MCP sending is scope-gated", () => {
  it("refuses to send with an ordinary key", async () => {
    const created = await tool("day3_create_campaign", {
      subject: "Big news",
      markdown: "Body copy.",
    });
    const { isError, text } = await tool("day3_send_campaign", {
      campaign_id: created.data.id,
    });
    expect(isError).toBe(true);
    expect(text).toContain("campaigns:send");
    // Nothing entered the pipeline.
    expect(queued).toHaveLength(0);
    const row = await currentDb.query.campaigns.findFirst({
      where: eq(campaigns.id, String(created.data.id)),
    });
    expect(row?.status).toBe("draft");
  });

  it("refuses to schedule with an ordinary key", async () => {
    const created = await tool("day3_create_campaign", {
      subject: "Big news",
      markdown: "Body copy.",
    });
    const { isError } = await tool("day3_schedule_campaign", {
      campaign_id: created.data.id,
      send_at: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(isError).toBe(true);
  });

  it("sends with a scoped key", async () => {
    currentKey = await seedKey(currentDb, currentAccount.id, ["campaigns:send"]);
    const created = await tool("day3_create_campaign", {
      subject: "Big news",
      markdown: "Body copy.",
    });
    const { isError, data } = await tool("day3_send_campaign", {
      campaign_id: created.data.id,
    });
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data.status).toBe("pending_review");
    expect(queued).toEqual([
      { type: "review_campaign", campaignId: created.data.id, accountId: currentAccount.id },
    ]);
  });

  it("schedules with a scoped key", async () => {
    currentKey = await seedKey(currentDb, currentAccount.id, ["campaigns:send"]);
    const created = await tool("day3_create_campaign", {
      subject: "Big news",
      markdown: "Body copy.",
    });
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    const { isError, data } = await tool("day3_schedule_campaign", {
      campaign_id: created.data.id,
      send_at: sendAt,
    });
    expect(isError, JSON.stringify(data)).toBe(false);
    expect(data.status).toBe("scheduled");
    expect(data.scheduled_at).toBe(sendAt);
  });

  it("reports a send gate as readable guidance rather than a protocol error", async () => {
    currentKey = await seedKey(currentDb, currentAccount.id, ["campaigns:send"]);
    // No mailing address → the CAN-SPAM gate.
    await currentDb
      .update((await import("../src/db/schema")).accounts)
      .set({ companyAddress: null })
      .where(eq((await import("../src/db/schema")).accounts.id, currentAccount.id));
    currentAccount = { ...currentAccount, companyAddress: null };

    const created = await tool("day3_create_campaign", {
      subject: "Big news",
      markdown: "Body copy.",
    });
    const { isError, text } = await tool("day3_send_campaign", { campaign_id: created.data.id });
    expect(isError).toBe(true);
    expect(text).toContain("mailing address");
  });
});

describe("MCP tenancy", () => {
  it("cannot reach another account's campaign", async () => {
    const other = await seedAccount(currentDb, { name: "Other Co" });
    const otherAudience = await seedAudience(currentDb, other.id);
    const now = nowIso();
    const strangerId = newId("cmp");
    await currentDb.insert(campaigns).values({
      id: strangerId,
      accountId: other.id,
      audienceId: otherAudience.id,
      sendingDomainId: "dom_other",
      name: "Theirs",
      subject: "Theirs",
      fromName: "Other",
      fromEmail: "hi@other.test",
      htmlBody: "<p>secret</p>",
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });

    const { isError, text } = await tool("day3_get_campaign", { campaign_id: strangerId });
    expect(isError).toBe(true);
    expect(text).toContain("not found");
    expect(text).not.toContain("secret");
  });
});
