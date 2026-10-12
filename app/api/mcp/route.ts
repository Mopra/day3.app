import type { NextRequest } from "next/server";
import { ApiError } from "@/api/v1/errors";
import { keyHasScope, parseScopes } from "@/api/v1/scopes";
import { HttpError } from "@/api/http";
import { handleMessage, PROTOCOL_VERSION, RPC_INTERNAL_ERROR, RPC_PARSE_ERROR } from "@/mcp/protocol";
import { SERVER_INSTRUCTIONS, TOOLS } from "@/mcp/tools";
import { resolveMcpContext, type McpContext } from "@/mcp/auth";
import { insufficientScopeChallenge, STEP_UP_SCOPES, unauthorizedChallenge } from "@/mcp/oauth-metadata";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger, newCorrelationId } from "@/lib/logger";

// Day3's MCP endpoint: https://<app>/api/mcp
//
// Two credentials, resolved in src/mcp/auth.ts. The default is OAuth: a client
// with no credential gets a 401 naming our protected-resource metadata, follows
// it to Clerk, and the user signs in and approves in a browser:
//
//   claude mcp add --transport http day3 https://<app>/api/mcp
//
// The other is the same bearer key the REST API uses, for scripts and for
// clients without OAuth support:
//
//   claude mcp add --transport http day3 https://<app>/api/mcp --header "Authorization: Bearer day3_live_..."
//
// One line on purpose — see the note in src/lib/api-docs.ts. A `\` continuation
// is bash-only, and on Windows it drops the header, which lands the user in an
// OAuth-discovery error that never mentions authentication.
//
// Stateless by construction — no session id is issued, every request
// re-authenticates, and any instance can serve any request.

const SERVER = {
  name: "day3",
  version: "1.0.0",
  instructions: SERVER_INSTRUCTIONS,
};

function rpcError(code: number, message: string, status = 200): Response {
  return Response.json(
    { jsonrpc: "2.0", id: null, error: { code, message } },
    { status, headers: { "MCP-Protocol-Version": PROTOCOL_VERSION } },
  );
}

// What the model is told when a tool throws. Our own errors carry messages
// written to be read by a person ("Add your business mailing address in
// Settings…"), so they pass straight through — that is exactly the guidance the
// agent should relay. Anything else is a bug and must not leak internals.
function toolErrorMessage(err: unknown): string {
  if (err instanceof ApiError || err instanceof HttpError) return err.message;
  return "Day3 hit an unexpected error handling that request.";
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = newCorrelationId("mcp");
  const log = logger.child({ requestId, path: "/api/mcp" });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return rpcError(RPC_PARSE_ERROR, "Invalid JSON body", 400);
  }

  // `initialize` and `tools/list` are answered without hitting the database, but
  // they are NOT public: an unauthenticated caller must not be able to enumerate
  // the tool surface. So the key is checked up front for every method, and the
  // authenticated context is then reused by tools/call rather than re-resolved.
  const origin = new URL(req.url).origin;
  let ctx: McpContext;
  try {
    ctx = await resolveMcpContext(req);
  } catch (err) {
    const message = err instanceof ApiError ? err.message : "Invalid credentials.";
    // A 403 here is an authenticated caller we cannot place in a workspace
    // (no membership, ambiguous org). Re-running OAuth would not fix it, so it
    // is not a 401 challenge.
    const status = err instanceof ApiError && err.status === 403 ? 403 : 401;
    if (status === 401 && !(err instanceof ApiError)) void log.reportError("mcp auth failed", err);
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message } },
      {
        status,
        headers: {
          ...(status === 401 ? { "WWW-Authenticate": unauthorizedChallenge(origin) } : {}),
          "MCP-Protocol-Version": PROTOCOL_VERSION,
        },
      },
    );
  }

  // Step-up: an OAuth connection calling a tool it has no scope for is
  // challenged at the HTTP layer, so the client can send the human back to the
  // consent screen for exactly that grant. An API key cannot be stepped up (the
  // fix is a new key), so it falls through to the tool's own readable refusal.
  const neededScope = ctx.credential.kind === "oauth" ? stepUpScopeFor(body) : null;
  if (neededScope && !keyHasScope(ctx.credential, neededScope)) {
    const id = (body as { id?: string | number }).id ?? null;
    return Response.json(
      {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32001,
          message: `This connection is missing the \`${neededScope}\` scope. Approve it on the Day3 consent screen to continue.`,
        },
      },
      {
        status: 403,
        headers: {
          "WWW-Authenticate": insufficientScopeChallenge(origin, parseScopes(ctx.credential.scopes), neededScope),
          "MCP-Protocol-Version": PROTOCOL_VERSION,
        },
      },
    );
  }

  const rate = await checkRateLimit("public_api", ctx.account.id);
  if (!rate.allowed) {
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Rate limit exceeded." } },
      {
        status: 429,
        headers: {
          "Retry-After": String(rate.retryAfterSeconds),
          "MCP-Protocol-Version": PROTOCOL_VERSION,
        },
      },
    );
  }

  try {
    const response = await handleMessage(body, {
      tools: TOOLS,
      context: async () => ctx,
      server: SERVER,
      onError: (err) => {
        // Tool failures are returned to the model, so the ones that are real
        // bugs still need to reach us rather than vanishing into a chat.
        if (!(err instanceof ApiError) && !(err instanceof HttpError)) {
          void log.reportError("mcp tool failed", err);
        }
        return toolErrorMessage(err);
      },
    });

    // A notification gets no body: 202 Accepted, per the transport spec.
    if (response === null) {
      return new Response(null, {
        status: 202,
        headers: { "MCP-Protocol-Version": PROTOCOL_VERSION },
      });
    }
    return Response.json(response, {
      headers: { "MCP-Protocol-Version": PROTOCOL_VERSION, "x-request-id": requestId },
    });
  } catch (err) {
    void log.reportError("unhandled error in mcp route", err);
    return rpcError(RPC_INTERNAL_ERROR, "Internal error");
  }
}

function stepUpScopeFor(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const msg = body as { method?: unknown; params?: { name?: unknown } };
  if (msg.method !== "tools/call" || typeof msg.params?.name !== "string") return null;
  return STEP_UP_SCOPES[msg.params.name] ?? null;
}

// The transport lets a client open an SSE stream here for server-initiated
// messages. This server never sends any, so it declines rather than holding a
// connection open that will only ever be silent.
export function GET(): Response {
  return new Response("This MCP endpoint does not provide an event stream. Use POST.", {
    status: 405,
    headers: { Allow: "POST, DELETE" },
  });
}

// Session teardown. There is no session to tear down, so this is a no-op that
// exists so a well-behaved client's cleanup doesn't log a 405.
export function DELETE(): Response {
  return new Response(null, { status: 204 });
}
