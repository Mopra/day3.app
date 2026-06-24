import type { NextRequest } from "next/server";
import { route } from "@/api/http";
import { getDb } from "@/db/client";
import { verifyClickToken, recordClick } from "@/services/open-tracking";
import { requireUnsubscribeSecret } from "@/lib/env";
import { logger } from "@/lib/logger";

// Public, unauthenticated link-tracking redirect. Verifies the HMAC-signed token,
// records the click (best-effort), then 302s to the destination embedded IN the
// token — never to a query param — so this can't be turned into an open redirect.
// verifyClickToken already guarantees the URL is absolute http(s).
export const GET = route(async (req: NextRequest) => {
  const token = req.nextUrl.searchParams.get("t") ?? "";
  const payload = await verifyClickToken(token, requireUnsubscribeSecret());

  if (!payload) {
    // Forged or long-expired link: we have no trusted destination to send the
    // reader to, so fall back to our own app/marketing root rather than a dead
    // page. (Response.redirect needs an absolute URL; if APP_URL is unset, 410.)
    const fallback = process.env.APP_URL;
    return fallback
      ? Response.redirect(fallback, 302)
      : new Response("This link has expired.", { status: 410 });
  }

  try {
    await recordClick(getDb(), payload);
  } catch (err) {
    void logger.reportError("click-tracking record failed", err);
  }
  return Response.redirect(payload.url, 302);
});
