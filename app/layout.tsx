import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { dark } from "@clerk/themes";
import { Toaster } from "sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "Day3",
  description: "Newsletter sending for small SaaS teams.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-16.png", sizes: "16x16", type: "image/png" },
    ],
    apple: [{ url: "/apple-touch-icon.png" }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <ClerkProvider afterSignOutUrl="/" appearance={{ theme: dark }}>
      <html lang="en" className="dark" suppressHydrationWarning>
        <body className="antialiased">
          {children}
          <Toaster theme="dark" richColors position="bottom-right" />
        </body>
      </html>
    </ClerkProvider>
  );
}
