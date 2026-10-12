import { and, eq, sql } from "drizzle-orm";
import { auth, clerkClient } from "@clerk/nextjs/server";
import type { ClerkClient } from "@clerk/backend";
import { requireApiKey } from "../api/v1/auth";
import { ApiError } from "../api/v1/errors";
import { isApiScope, serializeScopes, type ApiScope } from "../api/v1/scopes";
import { getDb, type Db } from "../db/client";
import { accountUsers, type Account } from "../db/schema";
import { getAccountByClerkOrgId, reconcileMembership, roleFromClerk, syncCurrentOrganization } from "../services/accounts";

// Who is calling the MCP server, and with what grant.
//
// Two credentials reach the same tools. A `day3_live_` API key is the original
// one: minted in the app, pasted into the editor's config. A Clerk OAuth access
// token is the other: the editor discovers our authorization server from the
// 401, the user signs in and approves in a browser, and nothing is ever pasted.
// Both resolve to one account and one set of elevated scopes, so a tool never
// has to know which door the caller came through.
//
// The OAuth scopes are Clerk custom scopes with the SAME names as the key scopes
// (`campaigns:send`, `automations:enroll`), created in the Clerk Dashboard and
// granted on the consent screen. The reasoning in api/v1/scopes.ts carries over
// unchanged: the base grant writes content, a scope is what puts mail in a
// stranger's inbox, and an agent does not get that by default.

export type McpCredential = {
  kind: "api_key" | "oauth";
  // Shown back to the agent in day3_context so it can tell the human which
  // grant it holds.
  name: string;
  // JSON array, the same shape api_keys.scopes stores, so the scope helpers in
  // api/v1/scopes.ts take either credential.
  scopes: string;
};

export type McpContext = { db: Db; account: Account; credential: McpCredential };

// What to tell the human when a token lacks a scope. A key is fixed by minting
// a new one; an OAuth grant is fixed by reconnecting and ticking the scope.
export function scopeFix(credential: McpCredential, scope: ApiScope): string {
  if (credential.kind === "api_key") return "";
  return (
    `Disconnect Day3 in your AI client, connect again, and approve \`${scope}\` on the ` +
    "consent screen. It is off unless you tick it."
  );
}

const DAY3_KEY_RE = /^Bearer\s+day3_/i;

// The OAuth verifier is a seam so tests can stand in for Clerk. Production reads
// the token through clerkMiddleware's request state (proxy.ts runs on /api/mcp).
export type VerifiedOAuthToken = {
  userId: string;
  clientId: string;
  scopes: string[];
  // The organization the user picked on the consent screen. Requested with the
  // `user:org:read` scope; null when the client did not ask for it.
  orgId: string | null;
};

export type OAuthVerifier = (req: Request) => Promise<VerifiedOAuthToken | null>;

export async function resolveMcpContext(
  req: Request,
  verifyOAuth: OAuthVerifier = verifyClerkOAuthToken,
): Promise<McpContext> {
  const header = req.headers.get("authorization") ?? "";
  if (!header || DAY3_KEY_RE.test(header)) {
    const { db, account, apiKey } = await requireApiKey(req);
    return {
      db,
      account,
      credential: { kind: "api_key", name: apiKey.name, scopes: apiKey.scopes ?? "[]" },
    };
  }

  const token = await verifyOAuth(req);
  if (!token) throw new ApiError(401, "invalid_token", "Invalid or expired access token. Reconnect Day3.");

  const db = getDb();
  const account = await accountForOAuthUser(db, token.userId, token.orgId);
  const scopes = token.scopes.filter((s): s is ApiScope => isApiScope(s));
  return {
    db,
    account,
    credential: { kind: "oauth", name: `OAuth client ${token.clientId}`, scopes: serializeScopes(scopes) },
  };
}

async function verifyClerkOAuthToken(_req: Request): Promise<VerifiedOAuthToken | null> {
  const state = await auth({ acceptsToken: "oauth_token" });
  if (!state.isAuthenticated) return null;
  // Clerk verified the JWT; @clerk/backend just does not surface its org_id
  // claim. Reading the payload of the token it already verified is safe. An
  // opaque (non-JWT) token has no claims to read, and falls back to membership.
  const raw = await state.getToken();
  return {
    userId: state.userId,
    clientId: state.clientId,
    scopes: state.scopes,
    orgId: raw ? orgIdFromJwt(raw) : null,
  };
}

export function orgIdFromJwt(token: string): string | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
    return typeof payload.org_id === "string" && payload.org_id ? payload.org_id : null;
  } catch {
    return null;
  }
}

// The account the token speaks for. INVARIANT, same as requireAccount: the org
// comes from Clerk (the token, or the user's memberships), never from the
// request, and the user must be a member of it right now. The org_id in a token
// was true when it was granted; a membership removed since must not keep working
// for the token's remaining lifetime.
async function accountForOAuthUser(db: Db, userId: string, tokenOrgId: string | null): Promise<Account> {
  const clerk = await clerkClient();

  let orgId = tokenOrgId;
  if (!orgId) {
    // No org on the token: the client did not request `user:org:read`. Fall
    // back to the user's memberships. One org is unambiguous; several are not,
    // and guessing would put one workspace's agent in another's data.
    const memberships = await clerk.users.getOrganizationMembershipList({ userId, limit: 2 });
    if (memberships.data.length === 1) orgId = memberships.data[0].organization.id;
    else if (memberships.data.length > 1) {
      throw new ApiError(
        403,
        "workspace_required",
        "You belong to more than one Day3 workspace. Reconnect Day3 and pick the workspace on the consent screen.",
      );
    } else {
      orgId = await createFirstWorkspace(db, clerk, userId);
    }
  }

  const account = await getAccountByClerkOrgId(db, orgId);
  if (account) {
    const member = await db.query.accountUsers.findFirst({
      columns: { id: true },
      where: and(eq(accountUsers.accountId, account.id), eq(accountUsers.clerkUserId, userId)),
    });
    if (member) return account;
  }

  // Not a known local member: ask Clerk, which is the authority on membership.
  // This also covers a teammate who has never opened the app (the membership
  // webhook may not have landed) and an org whose account row does not exist yet.
  const list = await clerk.organizations.getOrganizationMembershipList({ organizationId: orgId, userId: [userId] });
  const membership = list.data.find((m) => m.publicUserData?.userId === userId);
  if (!membership) throw new ApiError(403, "not_a_member", "You are no longer a member of this Day3 workspace.");

  if (!account) {
    // First sight of this org. No session means no billing claim, so the row is
    // created on Free; the next app load or billing webhook corrects the plan.
    // Never call this for an EXISTING account: without `has` it would read a
    // paying org as Free and downgrade it.
    return syncCurrentOrganization(db, clerk, { userId, orgId, orgRole: membership.role });
  }
  const user = await clerk.users.getUser(userId);
  const email = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ?? "";
  await reconcileMembership(db, { accountId: account.id, clerkUserId: userId, email, role: roleFromClerk(membership.role) });
  return account;
}

// A login with no workspace gets one, named after it, instead of an error.
//
// This is how an agent onboards itself: it signs up through the OAuth flow
// (with AgentID, or any sign-in the instance offers) and its first MCP call
// lands in a fresh workspace on the free tier. Nothing about that tier is
// special-cased for agents: sandbox sends to the workspace's own members, the
// new-account ramp, content review, and a card through Clerk Billing before
// mail reaches anyone else. A human signing up in the browser gets exactly the
// same account; this only removes the one page an agent cannot click through.
//
// Serialized per user with an advisory lock and a re-read inside it, because an
// MCP client fires several calls at once on connect, and two workspaces would
// strand the user on the "more than one workspace" refusal above.
async function createFirstWorkspace(db: Db, clerk: ClerkClient, userId: string): Promise<string> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`mcp-first-workspace:${userId}`}))`);
    const again = await clerk.users.getOrganizationMembershipList({ userId, limit: 1 });
    if (again.data.length > 0) return again.data[0].organization.id;

    const user = await clerk.users.getUser(userId);
    const viaAgent = user.externalAccounts.some((a) => /agentid/i.test(a.provider));
    const label =
      user.firstName?.trim() ||
      user.username?.trim() ||
      user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress.split("@")[0] ||
      "My";
    const org = await clerk.organizations.createOrganization({
      name: `${label}'s workspace`,
      createdBy: userId,
      // Where the workspace came from, for whoever later wonders why it has no
      // browser sign-up behind it. Private: the tenant never sees it.
      privateMetadata: { createdVia: viaAgent ? "agentid" : "mcp_oauth" },
    });
    console.info(`[mcp] created workspace ${org.id} for ${userId} (${viaAgent ? "agentid" : "oauth"})`);
    return org.id;
  });
}
