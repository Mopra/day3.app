import type { NextConfig } from "next";

const nextConfig: NextConfig = {
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
