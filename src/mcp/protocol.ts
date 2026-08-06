// A minimal, stateless Model Context Protocol server over Streamable HTTP.
//
// Why hand-rolled instead of the reference SDK: this server exposes tools and
// nothing else — no resources, no prompts, no sampling, no server-initiated
// messages — so every exchange is one JSON-RPC request in, one JSON-RPC response
// out. The spec explicitly allows a server to answer a POST with a plain
// `application/json` body instead of opening an SSE stream, which is the whole
// protocol surface we need. The SDK's transport wants Node's req/res objects and
// a session store, neither of which fits a Next.js route handler on serverless
// compute, and the adapter layers that bridge the two are more moving parts than
// the ~150 lines below.
//
// Statelessness is a feature here, not a shortcut: each request carries its own
// bearer key and is authenticated independently, so the server holds no session
// and any instance can serve any request.

export type JsonRpcId = string | number | null;

export type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: Record<string, unknown>;
};

export type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

// JSON-RPC reserved codes. Everything a *tool* can go wrong with is reported as
// a successful call with isError set (see below), not as one of these.
export const RPC_PARSE_ERROR = -32700;
export const RPC_INVALID_REQUEST = -32600;
export const RPC_METHOD_NOT_FOUND = -32601;
export const RPC_INTERNAL_ERROR = -32603;

// The newest protocol revision this server was written against. A client that
// asks for a different one still gets served — we speak the common subset
// (initialize + tools) that has been stable across every revision — so the
// negotiated version echoes the client's request when it looks like a real
// revision, and falls back to ours when it doesn't.
export const PROTOCOL_VERSION = "2025-06-18";

function negotiateVersion(requested: unknown): string {
  return typeof requested === "string" && /^\d{4}-\d{2}-\d{2}$/.test(requested)
    ? requested
    : PROTOCOL_VERSION;
}

export type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type Tool<Ctx> = {
  name: string;
  title: string;
  description: string;
  // JSON Schema for the arguments object.
  inputSchema: Record<string, unknown>;
  // Hints the client may show a user before running the tool. `destructiveHint`
  // is the one that matters: it marks the tools that put email in inboxes.
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean };
  handler: (args: Record<string, unknown>, ctx: Ctx) => Promise<unknown>;
};

export type ServerInfo = {
  name: string;
  version: string;
  instructions: string;
};

function ok(id: JsonRpcId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

function fail(id: JsonRpcId, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

// A tool failure is reported as a SUCCESSFUL rpc call carrying isError, per the
// spec: the model is supposed to see "that didn't work, here's why" as a result
// it can act on, rather than a transport-level error it can only surrender to.
function toolError(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function describeTools<Ctx>(tools: Tool<Ctx>[]): unknown {
  return {
    tools: tools.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  };
}

export async function callTool<Ctx>(
  tools: Tool<Ctx>[],
  ctx: Ctx,
  params: Record<string, unknown> | undefined,
  onError: (err: unknown) => string,
): Promise<ToolResult> {
  const name = typeof params?.name === "string" ? params.name : "";
  const tool = tools.find((t) => t.name === name);
  if (!tool) return toolError(`Unknown tool: ${name || "(none given)"}`);

  const args = (params?.arguments ?? {}) as Record<string, unknown>;
  try {
    const result = await tool.handler(args, ctx);
    return {
      content: [
        {
          type: "text",
          text: typeof result === "string" ? result : JSON.stringify(result, null, 2),
        },
      ],
    };
  } catch (err) {
    return toolError(onError(err));
  }
}

/**
 * Dispatch one JSON-RPC message. Returns null for a notification (which by
 * definition gets no response body).
 */
export async function handleMessage<Ctx>(
  message: unknown,
  opts: {
    tools: Tool<Ctx>[];
    context: () => Promise<Ctx>;
    server: ServerInfo;
    onError: (err: unknown) => string;
  },
): Promise<JsonRpcResponse | null> {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return fail(null, RPC_INVALID_REQUEST, "Expected a JSON-RPC 2.0 request object");
  }
  const rpc = message as JsonRpcRequest;
  const id = rpc.id ?? null;
  if (typeof rpc.method !== "string") {
    return fail(id, RPC_INVALID_REQUEST, "Missing `method`");
  }

  // Notifications carry no id and expect no reply.
  const isNotification = rpc.id === undefined || rpc.id === null;

  switch (rpc.method) {
    case "initialize":
      return ok(id, {
        protocolVersion: negotiateVersion(rpc.params?.protocolVersion),
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: opts.server.name, version: opts.server.version },
        instructions: opts.server.instructions,
      });

    case "ping":
      return ok(id, {});

    case "tools/list":
      return ok(id, describeTools(opts.tools));

    case "tools/call": {
      const ctx = await opts.context();
      return ok(id, await callTool(opts.tools, ctx, rpc.params, opts.onError));
    }

    default:
      if (rpc.method.startsWith("notifications/") || isNotification) return null;
      return fail(id, RPC_METHOD_NOT_FOUND, `Unsupported method: ${rpc.method}`);
  }
}
