import type { Metadata } from "next";
import { Geist, Instrument_Serif } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { shadcn } from "@clerk/themes";
import { Toaster } from "sonner";
import "./globals.css";

// The marketing site's pairing, so the walk from landing page to dashboard
// doesn't change typeface: Geist carries all UI and body text, Instrument
// Serif is the display face (see `.font-display` in globals.css). Both are
// wired to the `--font-*` variables the design tokens read from.
// Clerk calls the tenant an "organization"; the app calls it a workspace (the
// select-org screen, the plan copy). A new user's first act is naming it, in
// Clerk's own dialog, so its wording is overridden to match rather than the
// first screen and the second disagreeing about what they are creating.
const WORKSPACE_WORDING = {
  formFieldLabel__organizationName: "Workspace name",
  formFieldInputPlaceholder__organizationName: "Your company",
  organizationSwitcher: {
    action__createOrganization: "Create workspace",
    action__manageOrganization: "Manage workspace",
  },
  createOrganization: {
    title: "Create your workspace",
    formButtonSubmit: "Create workspace",
  },
  organizationList: {
    createOrganization: "Create workspace",
    action__createOrganization: "Create workspace",
    titleWithoutPersonal: "Choose a workspace",
  },
};

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap",
});

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
    <ClerkProvider
      afterSignOutUrl="/"
      localization={WORKSPACE_WORDING}
      // Clerk's shadcn theme reads the app's own design tokens (--card, --primary,
      // --border, --radius, --font-sans, ...) instead of shipping a palette of its
      // own, so the org switcher, user menu, sign-in and the organization profile
      // modal are painted with the same ink as everything around them. The stock
      // `dark` theme only shared the typeface; its blue-grey primary, shadows and
      // input chrome were what made those surfaces read as a different product.
      // The theme's Tailwind classes are picked up via the @import of
      // "@clerk/themes/shadcn.css" in globals.css.
      appearance={{
        theme: shadcn,
        variables: { fontFamily: "var(--font-geist)", borderRadius: "0.5rem" },
      }}
    >
      <html
        lang="en"
        className={`dark ${geist.variable} ${instrumentSerif.variable}`}
        suppressHydrationWarning
      >
        <body className="antialiased">
          {children}
          <Toaster theme="dark" richColors position="bottom-right" />
        </body>
      </html>
    </ClerkProvider>
  );
}
