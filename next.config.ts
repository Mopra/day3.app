import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The VPS worker lives in worker/** and is built/run separately (tsx); it is
  // never imported by the app, so Next ignores it. Both import shared code from
  // src/** via the "@/*" path alias.
};

export default nextConfig;
