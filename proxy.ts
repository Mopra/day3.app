import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Next 16 renamed middleware.ts → proxy.ts (Node runtime). clerkMiddleware
// supports it. Public surface: marketing/auth pages, the unsubscribe page +
// its public API, the public signup-form pages (/f/...) + API, the open-tracking
// pixel (/api/track/...), the health/readiness probe, and the inbound webhooks
// (Clerk + SES/SNS).
// Everything else requires a session — and the route handlers re-check via
// requireAuth/requireAccount, so this is defence-in-depth, not the only gate.
//
// NOTE: the public forms live at /f/... on the SAME app domain (production runs
// on go.day3.app). They are deliberately NOT on a separate host: a host-based
// rewrite would hijack the whole app. /f/<id> (stable, embeds) and
// /f/<account-slug>/<form-slug> (pretty) are plain public routes.
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  // Safety-net aliases: some Clerk flows redirect to /login (or /signup), which
  // this app does not serve. These routes redirect to /sign-in (or /sign-up) so
  // users never dead-end on the 404 page mid-auth.
  "/login(.*)",
  "/signup(.*)",
  // Public legal pages (linked from the marketing footer + every email footer).
  "/privacy",
  "/terms",
  "/unsubscribe(.*)",
  // Public hosted/embeddable signup-form pages.
  "/f(.*)",
  "/api/health",
  "/api/public(.*)",
  // Public API (bearer keys, not Clerk sessions) — requireApiKey() is the gate.
  "/api/v1(.*)",
  "/api/webhooks(.*)",
  // Open-tracking pixel — loaded by the recipient's mail client with no session.
  "/api/track(.*)",
]);

export default clerkMiddleware(async (auth, req) => {
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
