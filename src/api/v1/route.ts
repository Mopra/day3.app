import type { NextRequest } from "next/server";
import type { ZodType } from "zod";
import { logger, newCorrelationId } from "../../lib/logger";
import { checkRateLimit } from "../../lib/rate-limit";
import { HttpError } from "../http";
import { requireApiKey, type ApiContext } from "./auth";
import { ApiError, type ApiErrorCode } from "./errors";

// The v1 route wrapper: authenticates the bearer key, applies the per-account
// rate limit, runs the handler, and turns every failure into the documented
// envelope { error: { code, message, param?, request_id } }. RateLimit-* /
// x-request-id headers ride on every response.

type V1Handler<P> = (req: NextRequest, ctx: ApiContext, routeCtx: P) => Promise<Response>;

// Internal HttpError (thrown by shared services we reuse) → a generic v1 code.
// v1-owned code paths throw ApiError with precise codes; this mapping only
// covers errors that bubble up from shared internals.
function codeForStatus(status: number): ApiErrorCode {
  switch (status) {
    case 400:
      return "invalid_request";
    case 401:
      return "invalid_api_key";
    case 403:
      return "forbidden";
    case 404:
      return "not_found";
    case 409:
      return "invalid_request";
    case 429:
      return "rate_limit_exceeded";
    default:
      return "internal_error";
  }
}

function errorResponse(
  status: number,
  code: ApiErrorCode,
  message: string,
  requestId: string,
  extra?: { param?: string; headers?: Record<string, string> },
): Response {
  return Response.json(
    { error: { code, message, ...(extra?.param ? { param: extra.param } : {}), request_id: requestId } },
    { status, headers: { "x-request-id": requestId, ...extra?.headers } },
  );
}

export function apiRoute<P = unknown>(handler: V1Handler<P>): (req: NextRequest, routeCtx: P) => Promise<Response> {
  return async (req, routeCtx) => {
    const requestId = req.headers.get("x-request-id") ?? newCorrelationId("req");
    const log = logger.child({ requestId, method: req.method, path: new URL(req.url).pathname });
    try {
      const ctx = await requireApiKey(req);

      const rate = await checkRateLimit("public_api", ctx.account.id);
      const rateHeaders: Record<string, string> = {
        "RateLimit-Limit": String(rate.limit),
        "RateLimit-Remaining": String(rate.remaining),
      };
      if (!rate.allowed) {
        throw new ApiError(429, "rate_limit_exceeded", "Rate limit exceeded. Slow down and retry.", {
          headers: { ...rateHeaders, "Retry-After": String(rate.retryAfterSeconds) },
        });
      }

      const res = await handler(req, ctx, routeCtx);
      for (const [k, v] of Object.entries(rateHeaders)) res.headers.set(k, v);
      res.headers.set("x-request-id", requestId);
      return res;
    } catch (err) {
      if (err instanceof ApiError) {
        return errorResponse(err.status, err.code, err.message, requestId, err.opts);
      }
      if (err instanceof HttpError) {
        return errorResponse(err.status, codeForStatus(err.status), err.message, requestId, {
          headers: err.headers,
        });
      }
      void log.reportError("unhandled error in v1 route handler", err);
      return errorResponse(500, "internal_error", "Internal error", requestId);
    }
  };
}

// Parse + validate a JSON body → ApiError(400, invalid_request) with the
// offending field as `param`. v1's counterpart of the internal parseJson.
export async function readJson<T>(req: NextRequest, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new ApiError(400, "invalid_request", "Invalid JSON body");
  }
  const result = schema.safeParse(raw);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue.path.join(".");
    throw new ApiError(400, "invalid_request", `${path ? `${path}: ` : ""}${issue.message}`, {
      param: path || undefined,
    });
  }
  return result.data;
}
