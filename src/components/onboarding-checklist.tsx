"use client";

import Link from "next/link";
import { Check } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { OnboardingState } from "@/lib/types";

type Step = {
  title: string;
  description: string;
  done: boolean;
  href: string;
  cta: string;
};

// Guides the core conversion path (subscribe → verify a domain → import an
// audience → create → send). Reflects the real, server-computed account state.
export function OnboardingChecklist({ onboarding }: { onboarding: OnboardingState }) {
  const steps: Step[] = [
    {
      title: "Activate your plan",
      description: "Subscribe so your account can send email.",
      done: onboarding.billingActive,
      href: "/billing",
      cta: "Go to billing",
    },
    {
      title: "Verify a sending domain",
      description: "Add a domain and publish its DNS records so email lands in the inbox.",
      done: onboarding.hasVerifiedDomain,
      href: "/domains",
      cta: "Set up a domain",
    },
    {
      title: "Import an audience",
      description: "Create an audience and import subscribers from a CSV.",
      done: onboarding.hasSubscribers,
      href: "/audiences",
      cta: "Add subscribers",
    },
    {
      title: "Create a campaign",
      description: "Draft your first email and pick its audience and sending domain.",
      done: onboarding.hasCampaign,
      href: "/campaigns/new",
      cta: "Create a campaign",
    },
    {
      title: "Send your first campaign",
      description: "Submit a campaign for review and send it to your audience.",
      done: onboarding.hasSentCampaign,
      href: "/campaigns",
      cta: "View campaigns",
    },
  ];

  const completed = steps.filter((s) => s.done).length;
  if (completed === steps.length) return null;

  // The first not-yet-done step is the user's next action.
  const nextIndex = steps.findIndex((s) => !s.done);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between">
          <span>Get set up</span>
          <span className="text-sm font-normal text-muted-foreground">
            {completed} of {steps.length} done
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {steps.map((step, i) => {
            const isNext = i === nextIndex;
            return (
              <li
                key={step.title}
                className={cn(
                  "flex items-start gap-3 rounded-lg border p-3",
                  step.done
                    ? "border-border/50 opacity-60"
                    : isNext
                      ? "border-primary"
                      : "border-border",
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs",
                    step.done
                      ? "border-primary bg-primary text-primary-foreground"
                      : "border-muted-foreground/40 text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {step.done ? <Check className="h-3 w-3" /> : i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className={cn("text-sm font-medium", step.done && "line-through")}>
                    {step.title}
                  </div>
                  {!step.done && (
                    <p className="text-xs text-muted-foreground">{step.description}</p>
                  )}
                </div>
                {!step.done && (
                  <Link
                    href={step.href}
                    className={cn(
                      "shrink-0 text-sm underline-offset-4 hover:underline",
                      isNext ? "font-medium text-primary" : "text-muted-foreground",
                    )}
                  >
                    {step.cta}
                  </Link>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
