import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/client";
import { accountUsers, type Account } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { seedAccount, testDb } from "./helpers";

// The OAuth half of the MCP endpoint: a Clerk access token instead of a
// day3_live_ key. Clerk itself is the seam that is replaced; the token is
// whatever `oauthState` says the verifier saw.

let currentDb: Db;
let account: Account;

type OAuthState = { userId: string; clientId: string; scopes: string[]; orgId: string | null } | null;
let oauthState: OAuthState = null;
let clerkMemberships: { orgId: string; role: string }[] = [];

function fakeJwt(payload: Record<string, unknown>): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "RS256" })}.${enc(payload)}.sig`;
}

vi.mock("@clerk/nextjs/server", () => ({
  auth: async () =>
    oauthState
      ? {
          isAuthenticated: true,
          tokenType: "oauth_token",
          userId: oauthState.userId,
          clientId: oauthState.clientId,
          scopes: oauthState.scopes,
          getToken: async () => fakeJwt(oauthState?.orgId ? { org_id: oauthState.orgId } : {}),
        }
      : { isAuthenticated: false },
  clerkClient: async () => ({
    users: {
      getOrganizationMembershipList: async () => ({
        data: clerkMemberships.map((m) => ({ organization: { id: m.orgId }, role: m.role })),
      }),
      getUser: async (id: string) => ({
        id,
        primaryEmailAddressId: "e1",
        emailAddresses: [{ id: "e1", emailAddress: "agent@example.com" }],
        unsafeMetadata: {},
      }),
    },
    organizations: {
      getOrganizationMembershipList: async ({ organizationId, userId }: { organizationId: string; userId: string[] }) => ({
        data: clerkMemberships
          .filter((m) => m.orgId === organizationId)
          .map((m) => ({ role: m.role, publicUserData: { userId: userId[0] } })),
      }),
    },
  }),
}));

vi.mock("../src/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/db/client")>()),
  getDb: () => currentDb,
}));

vi.mock("../src/lib/rate-limit", () => ({
  checkRateLimit: async () => ({ allowed: true, limit: 100, remaining: 99, retryAfterSeconds: 0 }),
  enforceRateLimit: async () => {},
}));

const mcp = await import("../app/api/mcp/route");
const metadata = await import("../app/.well-known/oauth-protected-resource/api/mcp/route");
const { orgIdFromJwt } = await import("../src/mcp/auth");

async function rpc(method: string, params?: unknown, authorization = "Bearer clerk_oauth_token") {
  const res = await mcp.POST(
    new Request("https://go.day3.test/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }) as never,
  );
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function addMember(userId: string) {
  const now = nowIso();
  await currentDb.insert(accountUsers).values({
    id: newId("usr"),
    accountId: account.id,
    clerkUserId: userId,
    email: "agent@example.com",
    role: "admin",
    createdAt: now,
    updatedAt: now,
  });
}

beforeEach(async () => {
  currentDb = await testDb();
  account = await seedAccount(currentDb);
  oauthState = null;
  clerkMemberships = [];
  process.env.APP_URL = "https://go.day3.test";
  // pk_test_ + base64("clerk.day3.test$")
  process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY = `pk_test_${Buffer.from("clerk.day3.test$").toString("base64")}`;
});

describe("MCP OAuth discovery", () => {
  it("points an unauthenticated client at the protected-resource metadata", async () => {
    const res = await rpc("tools/list", undefined, "");
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://go.day3.test/.well-known/oauth-protected-resource/api/mcp"',
    );
  });

  it("names Clerk as the authorization server and does not advertise the send scope", async () => {
    const res = metadata.GET(new Request("https://go.day3.test/.well-known/oauth-protected-resource/api/mcp"));
    const body = await res.json();
    expect(body.resource).toBe("https://go.day3.test/api/mcp");
    expect(body.authorization_servers).toEqual(["https://clerk.day3.test"]);
    expect(body.scopes_supported).toContain("user:org:read");
    expect(body.scopes_supported).not.toContain("campaigns:send");
  });

  it("reads org_id from a JWT and tolerates an opaque token", () => {
    expect(orgIdFromJwt(fakeJwt({ org_id: "org_1" }))).toBe("org_1");
    expect(orgIdFromJwt("oat_opaque")).toBeNull();
  });
});

describe("MCP over OAuth", () => {
  it("resolves the workspace picked on the consent screen", async () => {
    await addMember("user_a");
    oauthState = { userId: "user_a", clientId: "client_1", scopes: ["openid"], orgId: account.clerkOrgId };
    const res = await rpc("tools/call", { name: "day3_context", arguments: {} });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.body.result.content[0].text);
    expect(data.workspace.name).toBe(account.name);
    expect(data.api_key.auth).toBe("oauth");
    expect(data.api_key.can_send_campaigns).toBe(false);
  });

  it("refuses a token whose user has left the workspace", async () => {
    oauthState = { userId: "user_gone", clientId: "client_1", scopes: [], orgId: account.clerkOrgId };
    const res = await rpc("tools/list");
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/no longer a member/);
  });

  it("re-admits a member Clerk knows about but the local table does not", async () => {
    clerkMemberships = [{ orgId: account.clerkOrgId, role: "org:member" }];
    oauthState = { userId: "user_new", clientId: "client_1", scopes: [], orgId: account.clerkOrgId };
    const res = await rpc("tools/list");
    expect(res.status).toBe(200);
  });

  it("falls back to the user's only workspace when the token names none", async () => {
    await addMember("user_a");
    clerkMemberships = [{ orgId: account.clerkOrgId, role: "org:admin" }];
    oauthState = { userId: "user_a", clientId: "client_1", scopes: [], orgId: null };
    expect((await rpc("tools/list")).status).toBe(200);
  });

  it("will not guess between several workspaces", async () => {
    clerkMemberships = [
      { orgId: account.clerkOrgId, role: "org:admin" },
      { orgId: "org_other", role: "org:admin" },
    ];
    oauthState = { userId: "user_a", clientId: "client_1", scopes: [], orgId: null };
    const res = await rpc("tools/list");
    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/more than one/);
  });

  it("challenges a send without the scope so the client can step up", async () => {
    await addMember("user_a");
    oauthState = { userId: "user_a", clientId: "client_1", scopes: ["openid"], orgId: account.clerkOrgId };
    const res = await rpc("tools/call", { name: "day3_send_campaign", arguments: { campaign_id: "cmp_x" } });
    expect(res.status).toBe(403);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain('error="insufficient_scope"');
    expect(challenge).toContain("campaigns:send");
    expect(challenge).toContain("user:org:read");
  });

  it("lets a granted scope through to the tool", async () => {
    await addMember("user_a");
    oauthState = {
      userId: "user_a",
      clientId: "client_1",
      scopes: ["openid", "campaigns:send"],
      orgId: account.clerkOrgId,
    };
    const res = await rpc("tools/call", { name: "day3_send_campaign", arguments: { campaign_id: "cmp_missing" } });
    // Past the scope gate: the tool itself answers (the campaign does not exist).
    expect(res.status).toBe(200);
    expect(res.body.result.isError).toBe(true);
    expect(res.body.result.content[0].text).not.toMatch(/scope/);
  });
});
