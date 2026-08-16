import type { ReactNode } from "react";
import Image from "next/image";
import Link from "next/link";
import { SiteFooter } from "@/components/site-footer";

// Shared chrome for the public legal pages: a logo header that links home, a
// constrained readable column, the "last updated" line, and the footer.
export function LegalShell({
  title,
  lastUpdated,
  children,
}: {
  title: string;
  lastUpdated: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-b border-border/60 px-4 py-4">
        <div className="mx-auto max-w-3xl">
          <Link href="/" aria-label="Day3 home">
            <Image
              src="/day3-lockup-light.svg"
              alt="Day3"
              width={120}
              height={31}
              className="opacity-90"
            />
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
        <h1 className="font-display text-4xl">{title}</h1>
        <p className="mt-2 text-sm text-muted-foreground">Last updated: {lastUpdated}</p>

        <div className="legal-prose mt-8 space-y-6 text-[0.95rem] leading-relaxed text-muted-foreground [&_a]:text-foreground [&_a]:underline [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_h2]:text-foreground [&_li]:ml-5 [&_li]:list-disc [&_p]:mt-3 [&_ul]:mt-3 [&_ul]:space-y-1">
          {children}
        </div>
      </main>

      <SiteFooter />
    </div>
  );
}
