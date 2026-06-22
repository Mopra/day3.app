import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { route } from "@/api/http";
import { getDb } from "@/db/client";
import { requireUnsubscribeSecret } from "@/lib/env";
import { enforceRateLimit, clientIp } from "@/lib/rate-limit";
import { formsPathPrefix } from "@/lib/public-url";
import { verifyFormConfirmToken } from "@/services/form-token";
import { confirmFormSignup } from "@/services/form-confirm";

// The double opt-in confirmation link target. The subscriber clicks the link in
// the confirmation email (a GET), we verify the HMAC token, flip pending →
// subscribed (idempotent), and redirect to the hosted result page. Keeping the
// logic in the API route and the rendering in the page keeps the page purely
// presentational.
function resultRedirect(req: NextRequest, formId: string | null, state: string): NextResponse {
  const prefix = formsPathPrefix(req.headers.get("host"));
  const path = formId ? `${prefix}/f/${formId}` : `${prefix}/f/unknown`;
  const url = new URL(path, req.nextUrl.origin);
  url.searchParams.set("state", state);
  return NextResponse.redirect(url, 303);
}

export const GET = route(async (req: NextRequest) => {
  await enforceRateLimit("form_confirm", clientIp(req));
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const payload = await verifyFormConfirmToken(token, requireUnsubscribeSecret());
  if (!payload) {
    return resultRedirect(req, null, "link-invalid");
  }

  const result = await confirmFormSignup(getDb(), payload);
  const state =
    result.outcome === "confirmed" || result.outcome === "already_confirmed"
      ? "confirmed"
      : result.outcome === "opted_out"
        ? "opted-out"
        : "link-invalid";
  return resultRedirect(req, payload.formId, state);
});
