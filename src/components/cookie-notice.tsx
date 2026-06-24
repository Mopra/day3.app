"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

const DISMISS_KEY = "day3.cookie-notice.dismissed";

// Lightweight, informational cookie notice. Day3 uses essential cookies only
// (login/session) — no advertising or cross-site tracking — so this informs
// rather than gates. Dismissal is remembered in localStorage. If non-essential
// cookies are ever added, replace this with a real consent manager that blocks
// them until the user opts in.
export function CookieNotice() {
  // Start hidden to avoid a flash before we've read localStorage on the client.
  const [show, setShow] = useState(false);

  useEffect(() => {
    try {
      if (!localStorage.getItem(DISMISS_KEY)) setShow(true);
    } catch {
      // localStorage unavailable (private mode / blocked) — just show it.
      setShow(true);
    }
  }, []);

  if (!show) return null;

  function dismiss() {
    try {
      localStorage.setItem(DISMISS_KEY, "1");
    } catch {
      /* ignore */
    }
    setShow(false);
  }

  return (
    <div className="fixed inset-x-0 bottom-0 z-50 border-t border-border bg-background/95 px-4 py-3 backdrop-blur supports-[backdrop-filter]:bg-background/80">
      <div className="mx-auto flex max-w-3xl flex-col items-center justify-between gap-3 text-sm sm:flex-row">
        <p className="text-muted-foreground">
          We use essential cookies to keep you signed in. See our{" "}
          <Link href="/privacy" className="text-foreground underline">
            Privacy Policy
          </Link>
          .
        </p>
        <Button size="sm" onClick={dismiss}>
          Got it
        </Button>
      </div>
    </div>
  );
}
