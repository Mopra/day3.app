import type { NextRequest } from "next/server";
import type { ZodType } from "zod";
import { logger, newCorrelationId } from "@/lib/logger";

// Thrown anywhere inside a handler to produce a specific HTTP error; the `route`
// wrapper turns it into a JSON response. Everything else becomes a 500.
// `headers` lets a specific error attach response headers (e.g. Retry-After on a
// 429 from the rate limiter).
export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
    public headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

type RouteHandler<C> = (req: NextRequest, context: C) => Promise<Response>;

// Wraps a Next route handler: HttpError → its JSON status, anything else → 500.
// Mirrors the Hono app's onError behaviour.
export function route<C = unknown>(handler: RouteHandler<C>): RouteHandler<C> {
  return async (req, context) => {
    // One correlation id per request, echoed on the 500 response so a user
    // report ("error id …") maps to the exact log line / error report.
    const requestId = req.headers.get("x-request-id") ?? newCorrelationId("req");
    const log = logger.child({ requestId, method: req.method, path: new URL(req.url).pathname });
    try {
      return await handler(req, context);
    } catch (err) {
      if (err instanceof HttpError) {
        return Response.json({ error: err.message }, { status: err.status, headers: err.headers });
      }
      // Unhandled → 500. Report with stack + safe (redacted) context to the
      // error sink and log it; the requestId ties the response to the report.
      void log.reportError("unhandled error in route handler", err);
      return Response.json(
        { error: "Internal error", requestId },
        { status: 500, headers: { "x-request-id": requestId } },
      );
    }
  };
}

// Parses + validates a JSON body, throwing HttpError(400) on bad JSON or a Zod
// failure (same message shape the Hono `parseJson` produced).
export async function parseJson<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".");
    throw new HttpError(400, `${path ? `${path}: ` : ""}${issue.message}`);
  }
  return result.data;
}
