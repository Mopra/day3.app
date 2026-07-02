"use client";

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { OnboardingState } from "@/lib/types";

// A one-line "here's your next move" strip, fed by the same server-computed
// onboarding state as the dashboard checklist. Dropped onto the domain, audience,
// and campaign pages so the golden path never dead-ends — a founder who just
// verified a domain sees "Import your audience →" without hunting for the nav.
// Renders nothing once the account has sent its first campaign (onboarding done),
// or when the current step is the one the page is already on (avoid pointing a
// user at the page they're looking at).
type Step = { key: string; href: string; label: string; hint: string };

export function NextSteps({
  onboarding,
  hideWhenOn,
}: {
  onboarding: OnboardingState;
  // The step key this page represents, so we don't tell the user to go where they
  // already are (e.g. hide the "verify a domain" nudge on the domains page).
  hideWhenOn?: Step["key"];
}) {
  if (onboarding.hasSentCampaign) return null;

  const steps: Step[] = [
    {
      key: "domain",
      href: "/domains",
      label: "Verify a sending domain",
      hint: "Publish your DNS records so email reaches the inbox.",
    },
    {
      key: "audience",
      href: "/audiences",
      label: "Import your audience",
      hint: "Add the subscribers you want to email.",
    },
    {
      key: "address",
      href: "/settings",
      label: "Add your business address",
      hint: "It's required by law in every email footer.",
    },
    {
      key: "campaign",
      href: "/campaigns/new",
      label: "Create your first campaign",
      hint: "Draft a product update and send it.",
    },
  ];

  const done: Record<string, boolean> = {
    domain: onboarding.hasVerifiedDomain,
    audience: onboarding.hasSubscribers,
    address: onboarding.hasMailingAddress,
    campaign: onboarding.hasCampaign,
  };

  const next = steps.find((s) => !done[s.key]);
  if (!next || next.key === hideWhenOn) return null;

  return (
    <Card className="border-primary/40 bg-primary/[0.03]">
      <CardContent className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium">Next: {next.label}</p>
          <p className="mt-0.5 text-sm text-muted-foreground">{next.hint}</p>
        </div>
        <Button render={<Link href={next.href} />} className="shrink-0">
          {next.label}
          <ArrowRight className="size-4" />
        </Button>
      </CardContent>
    </Card>
  );
}
