import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";

// Next 16 renamed middleware.ts → proxy.ts (Node runtime). clerkMiddleware
// supports it. Public surface: marketing/auth pages, the unsubscribe page +
// its public API, the health/readiness probe, and the inbound webhooks
// (Clerk + SES/SNS). Everything else
// requires a session — and the route handlers re-check via requireAuth/
// requireAccount, so this is defence-in-depth, not the only gate.
const isPublicRoute = createRouteMatcher([
  "/",
  "/sign-in(.*)",
  "/sign-up(.*)",
  "/unsubscribe(.*)",
  "/api/health",
  "/api/public(.*)",
  "/api/webhooks(.*)",
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
