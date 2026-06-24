import type { NextRequest } from "next/server";
import { route } from "@/api/http";
import { getDb } from "@/db/client";
import { verifyOpenToken, recordOpen } from "@/services/open-tracking";
import { requireUnsubscribeSecret } from "@/lib/env";
import { logger } from "@/lib/logger";

// The smallest valid GIF: a 1×1 fully-transparent pixel (43 bytes). Returned for
// every request so the recipient's mail client always renders an image — open
// tracking must never leave a broken-image placeholder, whatever the token does.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

function pixelResponse(): Response {
  return new Response(PIXEL, {
    status: 200,
    headers: {
      "Content-Type": "image/gif",
      "Content-Length": String(PIXEL.length),
      // Never cache: a cached pixel would suppress repeat loads we rely on, and
      // a shared CDN must not serve one recipient's pixel to another.
      "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
      Pragma: "no-cache",
      Expires: "0",
    },
  });
}

// Public, unauthenticated (the recipient's mail client loads it with no session).
// It verifies the HMAC-signed token and records a single open, but ALWAYS returns
// the pixel — a bad/expired token or a transient DB error must not surface to the
// reader as a failed image.
export const GET = route(async (req: NextRequest) => {
  const token = req.nextUrl.searchParams.get("t") ?? "";
  const payload = await verifyOpenToken(token, requireUnsubscribeSecret());
  if (payload) {
    try {
      await recordOpen(getDb(), payload);
    } catch (err) {
      void logger.reportError("open-tracking record failed", err);
    }
  }
  return pixelResponse();
});
