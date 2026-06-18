"use client";

import Link from "next/link";
import { useAuth } from "@clerk/nextjs";
import { Button } from "@/components/ui/button";

export default function LandingPage() {
  const { isSignedIn } = useAuth();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="max-w-2xl space-y-8 text-center">
        <div className="space-y-4">
          <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">Day3</h1>
          <p className="mx-auto max-w-lg text-lg text-muted-foreground">
            Simple product update emails for small SaaS teams.
            <br />
            No marketing suite. No contact tax. No free tier.
          </p>
        </div>

        <div className="flex justify-center gap-4">
          {isSignedIn ? (
            <Link href="/dashboard">
              <Button size="lg">Open dashboard</Button>
            </Link>
          ) : (
            <>
              <Link href="/sign-up">
                <Button size="lg">Get started — $5/mo</Button>
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
  );
}
