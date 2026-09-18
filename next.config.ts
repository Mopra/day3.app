import type { NextConfig } from "next";

// Applied everywhere. Nothing here depends on a page being public or private.
const BASELINE_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
];

// Refuse to be framed. The signup forms at /f/* are the whole exception — they
// exist to be embedded in a stranger's site — and they sit on the SAME origin as
// the app (go.day3.app; see proxy.ts for why they are not on their own host).
// So the deny rule cannot be blanket: without the carve-out below it would break
// every live embed, and without the deny rule the signed-in app is frameable by
// anyone and a click on an invisible overlay is a click in the user's session.
const FRAME_DENY_HEADERS = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
];

const nextConfig: NextConfig = {
  async headers() {
    return [
      { source: "/:path*", headers: BASELINE_HEADERS },
      // Everything except the embeddable form routes and the widget loader.
      // A negative lookahead rather than two overlapping rules, so which header
      // wins never depends on Next's match-ordering.
      { source: "/:path((?!f/|f$|embed\\.js$).*)", headers: FRAME_DENY_HEADERS },
      { source: "/", headers: FRAME_DENY_HEADERS },
      {
        // embed.js is fetched on every pageview of every site that installs a
        // form. Next serves public/ with max-age=0, so today each of those is a
        // revalidation round-trip to us on someone else's critical path.
        source: "/embed.js",
        headers: [
          {
            key: "Cache-Control",
            value: "public, max-age=600, s-maxage=86400, stale-while-revalidate=604800",
          },
        ],
      },
    ];
  },
  // The VPS worker lives in worker/** and is built/run separately (tsx); it is
  // never imported by the app, so Next ignores it. Both import shared code from
  // src/** via the "@/*" path alias.

  // Pages that were folded into a neighbour keep answering at their old URL:
  // bookmarks, the API docs and support replies all point here. Exact paths
  // only, so /domains/:id (the domain detail page) is untouched.
  async redirects() {
    return [
      { source: "/emails", destination: "/activity?source=api", permanent: true },
      { source: "/domains", destination: "/sending", permanent: true },
      { source: "/senders", destination: "/sending?tab=senders", permanent: true },
      { source: "/suppressions", destination: "/audiences?tab=suppressions", permanent: true },
    ];
  },
};

export default nextConfig;
