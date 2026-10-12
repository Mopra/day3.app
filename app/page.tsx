"use client";

import Image from "next/image";
import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";
import { SiteFooter } from "@/components/site-footer";
import { CookieNotice } from "@/components/cookie-notice";

export default function LandingPage() {
  const { isSignedIn } = useAuth();
  // The marketing site's CTAs land here with ga_cid and UTM tags. Carry them on
  // to /sign-up, which stores them for signup attribution
  // (src/services/signup-analytics.ts); dropping them here would lose the source.
  const [signUpHref, setSignUpHref] = useState("/sign-up");
  useEffect(() => {
    if (window.location.search) setSignUpHref(`/sign-up${window.location.search}`);
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <main className="flex flex-1 flex-col items-center justify-center px-4 py-16">
        <div className="max-w-2xl space-y-8 text-center">
        <div className="space-y-4">
          <h1 className="flex justify-center">
            <span className="sr-only">Day3</span>
            <Image
              src="/day3-lockup-light.svg"
              alt="Day3"
              width={235}
              height={60}
              priority
            />
          </h1>
          <p className="mx-auto max-w-lg text-lg text-muted-foreground">
            Simple product update emails for small SaaS teams.
            <br />
            No marketing suite. No contact tax. Set up and test free. Pay only to send to your list.
          </p>
        </div>

        <div className="flex justify-center gap-4">
          {isSignedIn ? (
            <Link href="/dashboard">
              <Button size="lg">Open dashboard</Button>
            </Link>
          ) : (
            <>
              <Link href={signUpHref}>
                <Button size="lg">Get started free</Button>
              </Link>
              <Link href="/sign-in">
                <Button variant="outline" size="lg">
                  Sign in
                </Button>
              </Link>
            </>
          )}
        </div>
        </div>
      </main>
      <SiteFooter />
      <CookieNotice />
    </div>
  );
}
