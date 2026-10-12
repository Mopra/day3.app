"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { SANDBOX_MONTHLY_ALLOWANCE } from "@/lib/plans-catalog";

// The free tier's sandbox mode, as the user meets it. Sandbox is one concept
// across the product — real sends, your own team only, one shared monthly
// allowance — so it gets one banner and one badge rather than a different
// explanation per surface. Only the middle sentence changes with the surface.

export function SandboxBadge({ className }: { className?: string }) {
  return (
    <Badge variant="outline" className={className}>
      Test mode
    </Badge>
  );
}

export type SandboxSurface = "campaign" | "transactional" | "automation";

const SURFACE_COPY: Record<SandboxSurface, string> = {
  campaign:
    "On the Free plan your campaigns send for real, through the same pipeline with the same tracking and metrics, but only to people on your team.",
  transactional:
    "On the Free plan the API sends for real, but only to people on your team. That is enough to build and test your integration.",
  automation:
    "On the Free plan this automation runs for real, but only people on your team are enrolled; anyone else who joins the audience is skipped. Upgrading lifts this for new signups right away, no republish needed.",
};

// `remaining` (when known) turns the banner from an explanation into a meter,
// which is what a user actually wants once they've read it the first time.
export function SandboxBanner({
  surface,
  remaining,
  className,
}: {
  surface: SandboxSurface;
  remaining?: number;
  className?: string;
}) {
  const exhausted = remaining !== undefined && remaining <= 0;
  // Checkout brings the user back here (billing-view reads ?next=), so upgrading
  // in the middle of a campaign doesn't strand them on Billing.
  const pathname = usePathname();
  return (
    <div className={className}>
      <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
        <span className="font-medium">Test mode.</span>{" "}
        <span className="text-muted-foreground">
          {SURFACE_COPY[surface]}{" "}
          {remaining !== undefined &&
            (exhausted
              ? `You've used all ${SANDBOX_MONTHLY_ALLOWANCE} test emails for this month. `
              : `${remaining.toLocaleString()} of ${SANDBOX_MONTHLY_ALLOWANCE} test emails left this month. `)}
          <Link
            href={`/billing?next=${encodeURIComponent(pathname)}`}
            className="underline underline-offset-2 hover:text-foreground"
          >
            Upgrade
          </Link>{" "}
          to send to your real audience.
        </span>
      </div>
    </div>
  );
}
