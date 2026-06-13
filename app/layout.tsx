import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Day3",
  description: "Newsletter sending for small SaaS teams.",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="antialiased">{children}</body>
    </html>
  );
}
