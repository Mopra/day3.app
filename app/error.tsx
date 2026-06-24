"use client";

// Route-segment error boundary. Catches any render/runtime error thrown by a page
// under app/ (the marketing page and the whole (app) group) and shows a friendly,
// branded recovery screen instead of a blank white page. `reset` re-renders the
// failed segment so a transient error can be retried without a full reload.
import { useEffect } from "react";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Surface to the browser console (and the server console for SSR errors). The
    // digest lets you correlate with server logs.
    console.error("App error boundary:", error);
  }, [error]);

  return (
    <main className="flex min-h-screen flex-col items-center justify-center px-4">
      <div className="max-w-md space-y-6 text-center">
        <Image
          src="/day3-lockup-light.svg"
          alt="Day3"
          width={160}
          height={41}
          className="mx-auto opacity-90"
          priority
        />
        <div className="space-y-2">
          <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
          <p className="text-muted-foreground">
            An unexpected error stopped this page from loading. It&apos;s usually temporary —
            try again, and if it keeps happening, let us know.
          </p>
        </div>
        <div className="flex justify-center gap-3">
          <Button onClick={reset}>Try again</Button>
          <Link href="/dashboard">
            <Button variant="outline">Back to dashboard</Button>
          </Link>
        </div>
        {error.digest && (
          <p className="text-xs text-muted-foreground">Reference: {error.digest}</p>
        )}
      </div>
    </main>
  );
}
