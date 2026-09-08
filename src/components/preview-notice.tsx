"use client";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

// Automations are the newest thing in Day3 and the first users are still finding
// the canvas's edges, so the product says so out loud rather than letting someone
// discover it by hitting one. Same shape as sandbox-notice.tsx, for the same
// reason: one concept, two pieces, so a badge and its explanation can never drift
// apart.
//
// The badge goes wherever a sentence would not fit (the detail header, beside the
// status and sandbox badges); the note goes on the page that introduces the
// feature. Deliberately not dismissible and deliberately not an alert box: it is
// a standing fact about the feature, not an event, and a red banner over a
// working page would overstate it.
//
// When automations leave preview, delete this file and its two call sites.

export function PreviewBadge({ className }: { className?: string }) {
  return (
    <Badge variant="secondary" className={className}>
      Early preview
    </Badge>
  );
}

export function PreviewNote({ className }: { className?: string }) {
  return (
    <p className={cn("max-w-2xl text-sm text-muted-foreground", className)}>
      Automations are in early preview. What you build here runs for real and sends real
      email, but this is the newest part of Day3, so you may still hit a rough edge. If
      something looks wrong, tell us through Help in the sidebar and we&apos;ll fix it.
    </p>
  );
}
