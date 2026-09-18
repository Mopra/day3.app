"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { OnboardingState } from "@/lib/types";

// The "here's your next move" strip, fed by the same server-computed onboarding
// state as the dashboard's checklist.
//
// It lives in <AppShell> rather than on individual pages because setup is where
// a new user spends their first session, and the checklist was only on the
// dashboard: someone part-way through DNS on /sending had no idea what came next
// or how much was left. Now the thread follows them. It renders nothing once the
// account has sent its first campaign, and nothing on the page that would fix
// the step it is pointing at (including the dashboard, which shows the full
// checklist and does not need a one-line echo of it).
//
// Order matches <FirstSendView>: see an email work, then your own domain, then a
// real audience. DNS is not step one any more.

type Step = { key: string; href: string; label: string; hint: string };

export function NextSteps({
  onboarding,
  className,
}: {
  onboarding: OnboardingState;
  className?: string;
}) {
  const pathname = usePathname();
  if (onboarding.hasSentCampaign) return null;

  const steps: Step[] = [
    ...(onboarding.canSendFirstEmail
      ? [
          {
            key: "first-send",
            href: "/dashboard",
            label: "Send yourself your first email",
            hint: "Nothing to set up. It goes to your team and nobody else.",
          },
        ]
      : []),
    {
      key: "domain",
      href: "/sending",
      label: "Verify a sending domain",
      hint: "Publish your DNS records so email reaches the inbox.",
    },
    {
      key: "audience",
      href: onboarding.onboardingPath === "building_list" ? "/forms" : "/audiences",
      label:
        onboarding.onboardingPath === "building_list"
          ? "Start collecting subscribers"
          : "Import your audience",
      hint:
        onboarding.onboardingPath === "building_list"
          ? "Publish a signup form and share the link."
          : "Add the subscribers you want to email.",
    },
    {
      key: "address",
      href: "/settings",
      label: "Add your business address",
      hint: "It's required by law in every email to your subscribers.",
    },
    {
      key: "campaign",
      href: "/campaigns/new",
      label: "Create your first campaign",
      hint: "Draft a product update and send it.",
    },
  ];

  const done: Record<string, boolean> = {
    "first-send": onboarding.hasSentCampaign,
    domain: onboarding.hasVerifiedDomain,
    audience: onboarding.hasOwnSubscribers,
    address: onboarding.hasMailingAddress,
    campaign: onboarding.hasCampaign,
  };

  const next = steps.find((s) => !done[s.key]);
  if (!next) return null;
  // Don't point someone at the page they are already on, and don't compete with
  // the dashboard's own checklist.
  if (pathname === "/dashboard" || pathname.startsWith(next.href)) return null;

  const remaining = steps.filter((s) => !done[s.key]).length;

  return (
    <Link
      href={next.href}
      className={cn(
        "group mb-5 flex items-center gap-3 rounded-lg border border-primary/30 bg-primary/[0.04] px-3 py-2 transition-colors hover:bg-primary/[0.07]",
        className,
      )}
    >
      <span className="min-w-0 flex-1 text-sm">
        <span className="font-medium">Next: {next.label}</span>{" "}
        <span className="text-muted-foreground">{next.hint}</span>
      </span>
      <span className="hidden shrink-0 text-xs text-muted-foreground tabular-nums sm:inline">
        {remaining} left
      </span>
      <ArrowRight
        className="size-4 shrink-0 text-primary transition-transform group-hover:translate-x-0.5"
        aria-hidden
      />
    </Link>
  );
}
