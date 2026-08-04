// Public-API (v1) error model. Unlike the internal HttpError (bare message),
// every v1 error carries a stable machine-readable `code` — the code is the
// contract, the message may change. The route wrapper (route.ts) turns these
// into the documented envelope:
//   { "error": { "code", "message", "param"?, "request_id" } }

export type ApiErrorCode =
  | "invalid_request"
  | "invalid_email"
  | "invalid_filter"
  | "batch_too_large"
  | "invalid_api_key"
  | "revoked_api_key"
  | "plan_limit_reached"
  | "test_keys_not_supported"
  | "forbidden"
  | "not_found"
  | "contact_already_exists"
  | "email_suppressed"
  | "sending_disabled"
  | "domain_not_verified"
  | "sandbox_recipient_not_allowed"
  | "idempotency_conflict"
  | "immutable_field"
  | "rate_limit_exceeded"
  | "internal_error";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: ApiErrorCode,
    message: string,
    public opts?: { param?: string; headers?: Record<string, string> },
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function apiJson(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json(data, { status, headers });
}
