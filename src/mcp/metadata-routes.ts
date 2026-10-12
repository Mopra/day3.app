import { clerkIssuer, protectedResourceMetadata } from "./oauth-metadata";

// Route handlers for the OAuth discovery documents (app/.well-known/...). They
// are public, and fetched cross-origin by browser-based MCP clients, so every
// response carries open CORS headers.

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

export function protectedResourceGET(req: Request): Response {
  const body = protectedResourceMetadata(new URL(req.url).origin);
  return Response.json(body, { headers: { ...CORS, "Cache-Control": "public, max-age=3600" } });
}

// Older MCP clients (spec 2025-03-26) look for authorization-server metadata on
// the resource's own origin instead of following authorization_servers. Serve
// Clerk's document verbatim so its endpoints stay Clerk's.
export async function authServerGET(): Promise<Response> {
  const issuer = clerkIssuer();
  if (!issuer) return Response.json({ error: "oauth_not_configured" }, { status: 503, headers: CORS });
  const upstream = await fetch(`${issuer}/.well-known/oauth-authorization-server`, {
    next: { revalidate: 3600 },
  } as RequestInit);
  if (!upstream.ok) return Response.json({ error: "upstream_unavailable" }, { status: 502, headers: CORS });
  return Response.json(await upstream.json(), {
    headers: { ...CORS, "Cache-Control": "public, max-age=3600" },
  });
}

export function metadataOPTIONS(): Response {
  return new Response(null, { status: 204, headers: CORS });
}
