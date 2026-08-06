import type { NextRequest } from "next/server";
import { requireApiKey, type ApiContext } from "@/api/v1/auth";
import { ApiError } from "@/api/v1/errors";
import { HttpError } from "@/api/http";
import { handleMessage, PROTOCOL_VERSION, RPC_INTERNAL_ERROR, RPC_PARSE_ERROR } from "@/mcp/protocol";
import { SERVER_INSTRUCTIONS, TOOLS } from "@/mcp/tools";
import { checkRateLimit } from "@/lib/rate-limit";
import { logger, newCorrelationId } from "@/lib/logger";

// Day3's MCP endpoint: https://<app>/api/mcp
//
// Authentication is the same bearer key the REST API uses, so there is one
// credential and one revocation path. Editors attach it as a header:
//
//   claude mcp add --transport http day3 https://<app>/api/mcp \
//     --header "Authorization: Bearer day3_live_..."
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
  let ctx: ApiContext;
  try {
    ctx = await requireApiKey(req);
  } catch (err) {
    const message = err instanceof ApiError ? err.message : "Invalid API key.";
    return Response.json(
      { jsonrpc: "2.0", id: null, error: { code: -32001, message } },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": 'Bearer realm="day3", error="invalid_token"',
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
