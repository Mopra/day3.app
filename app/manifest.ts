import type { MetadataRoute } from "next";

// PWA manifest, served at /manifest.webmanifest. Dark-theme brand colors:
// espresso background (#2B2019) with the day3 cream/caramel mark.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Day3",
    short_name: "Day3",
    description: "Newsletter sending for small SaaS teams.",
    start_url: "/",
    display: "standalone",
    background_color: "#2B2019",
    theme_color: "#2B2019",
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      {
        src: "/icon-maskable-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
