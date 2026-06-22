import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { isFormsHost } from "@/lib/public-url";

// Next 16 renamed middleware.ts → proxy.ts (Node runtime). clerkMiddleware
// supports it. Public surface: marketing/auth pages, the unsubscribe page +
// its public API, the public signup-form pages + API, the health/readiness
// probe, and the inbound webhooks (Clerk + SES/SNS). Everything else requires a
// session — and the route handlers re-check via requireAuth/requireAccount, so
// this is defence-in-depth, not the only gate.
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/unsubscribe(.*)",
  // Hosted/embeddable signup-form pages (also reachable directly in local dev,
  // where there is no dedicated forms host to rewrite from).
  "/hosted(.*)",
  "/api/health",
  "/api/public(.*)",
  "/api/webhooks(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
  // The public forms host (go.day3.app) is entirely unauthenticated. Its page
  // requests are rewritten under /hosted so the pretty /<account-slug>/<form-slug>
  // path can live at the root without shadowing app routes. The API
  // (/api/public/...) and Next internals are served as-is.
  if (isFormsHost(req.headers.get("host"))) {
    const { pathname } = req.nextUrl;
    if (
      pathname.startsWith("/api") ||
      pathname.startsWith("/hosted") ||
      pathname.startsWith("/_next")
    ) {
      return NextResponse.next();
    }
    const url = req.nextUrl.clone();
    url.pathname = `/hosted${pathname}`;
    return NextResponse.rewrite(url);
  }

  if (!isPublicRoute(req)) {
    await auth.protect();
  }
});

export const config = {
  matcher: [
    // Skip Next internals and static files unless referenced in search params.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes.
    "/(api|trpc)(.*)",
  ],
};
