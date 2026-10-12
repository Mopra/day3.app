import type { ApiScope } from "../api/v1/scopes";
import { docsUrl } from "../lib/docs-links";

// OAuth discovery for the MCP endpoint.
//
// An MCP client that gets a 401 from /api/mcp reads the `resource_metadata` URL
// out of the WWW-Authenticate header, fetches our protected-resource metadata
// (RFC 9728), and from it learns that Clerk is the authorization server. From
// there it is Clerk's flow: client registration (CIMD or DCR), sign-in, the
// consent screen with its workspace picker, tokens.
//
// Hand-rolled rather than @clerk/mcp-tools for the same reason as protocol.ts:
// it is two small JSON documents, and the helper library brings the reference
// MCP SDK with it.

// What a client gets when it asks for nothing in particular, and what we
// advertise. `user:org:read` is the load-bearing one: it makes Clerk's consent
// screen show the workspace picker and put the choice in the token as org_id.
// `offline_access` gets the client a refresh token, so a connection outlives
// the access token instead of sending the user back to the browser.
export const BASE_OAUTH_SCOPES = ["openid", "profile", "email", "offline_access", "user:org:read"] as const;

// The elevated scopes are deliberately NOT advertised. Some clients request
// every scope the metadata lists, and Clerk's consent screen is all or nothing,
// so advertising `campaigns:send` would make "connect" mean "and let it email
// my whole list". Instead a client asks for one when a tool needs it: the route
// answers that call with a 403 scope challenge (MCP step-up authorization), and
// the human approves sending on the consent screen at the moment it matters.
export const STEP_UP_SCOPES: Record<string, ApiScope> = {
  day3_send_campaign: "campaigns:send",
  day3_schedule_campaign: "campaigns:send",
  day3_enroll_in_automation: "automations:enroll",
};

export const MCP_PATH = "/api/mcp";
export const RESOURCE_METADATA_PATH = `/.well-known/oauth-protected-resource${MCP_PATH}`;

// Clerk's Frontend API origin, decoded from the publishable key the way Clerk's
// own SDKs do: `pk_(test|live)_` + base64("<frontend-api-host>$").
export function clerkIssuer(publishableKey = process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY): string | null {
  const match = /^pk_(?:test|live)_(.+)$/.exec(publishableKey ?? "");
  if (!match) return null;
  try {
    const host = Buffer.from(match[1], "base64").toString("utf8");
    if (!host.endsWith("$")) return null;
    return `https://${host.slice(0, -1)}`;
  } catch {
    return null;
  }
}

export function protectedResourceMetadata(origin: string) {
  const issuer = clerkIssuer();
  return {
    resource: `${origin}${MCP_PATH}`,
    resource_name: "Day3",
    authorization_servers: issuer ? [issuer] : [],
    scopes_supported: [...BASE_OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_documentation: docsUrl(),
  };
}

export function resourceMetadataUrl(origin: string): string {
  return `${origin}${RESOURCE_METADATA_PATH}`;
}

// The 401 challenge. Carrying resource_metadata is what lets a client with no
// key start the OAuth flow instead of dead-ending on "unauthorized".
export function unauthorizedChallenge(origin: string): string {
  return `Bearer realm="day3", error="invalid_token", resource_metadata="${resourceMetadataUrl(origin)}"`;
}

// The 403 step-up challenge for a token that lacks a scope. The scope list is
// what the client should request on re-authorization, so it is the base set plus
// what it already holds plus the new one; a client that asked for only the
// new scope would lose the workspace picker and the grants it had.
export function insufficientScopeChallenge(origin: string, held: string[], needed: ApiScope): string {
  const scope = [...new Set([...BASE_OAUTH_SCOPES, ...held, needed])].join(" ");
  return (
    `Bearer realm="day3", error="insufficient_scope", scope="${scope}", ` +
    `resource_metadata="${resourceMetadataUrl(origin)}"`
  );
}
