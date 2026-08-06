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

// Guides the core conversion path (verify a domain → import an audience →
// create → send). Every account starts on the always-active free tier, so there
// is no "subscribe first" gate — the first real step is verifying a domain.
// Reflects the real, server-computed account state.
export function OnboardingChecklist({ onboarding }: { onboarding: OnboardingState }) {
  const steps: Step[] = [
    {
      title: "Verify a sending domain",
      description: "Publish a few DNS records so inboxes trust your mail. We check them for you.",
      done: onboarding.hasVerifiedDomain,
      href: "/domains",
      cta: "Set up a domain",
    },
    {
      title: "Import an audience",
      description: "Create a list, then bring your subscribers in from a CSV.",
      done: onboarding.hasSubscribers,
      href: "/audiences",
      cta: "Add subscribers",
    },
    {
      title: "Create a campaign",
      description: "Write the email, then pick who gets it and which domain it leaves from.",
      done: onboarding.hasCampaign,
      href: "/campaigns/new",
      cta: "Create a campaign",
    },
    {
      // Was "Submit a campaign for review and send it to your audience", which
      // reads as though a human approves it first. There is no approval step:
      // sending runs the automated risk review and, if it passes, delivery
      // starts (see AGENTS.md — `pending_review` is not a human review). Copy
      // that implies a safety net nobody is holding is worse than no copy.
      title: "Send your first campaign",
      description: "Sending runs an automatic safety check, then goes out in batches. There's no undo.",
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
          {/* Names the outcome the list leads to rather than the list itself;
              the count beside it already says how far along you are. */}
          <span>Before your first send</span>
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
                  "rounded-lg border p-3",
                  step.done
                    ? "border-border/50 opacity-60"
                    : isNext
                      ? "border-primary"
                      : "border-border",
                )}
              >
                {/* Badge, title and CTA share one vertically-centered row so they
                    always line up; the description drops onto its own line,
                    indented (pl-8 = badge w-5 + gap-3) to sit under the title. */}
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      "flex h-5 w-5 shrink-0 items-center justify-center rounded-full border text-xs",
                      step.done
                        ? "border-primary bg-primary text-primary-foreground"
                        : "border-muted-foreground/40 text-muted-foreground",
                    )}
                    aria-hidden
                  >
                    {step.done ? <Check className="h-3 w-3" /> : i + 1}
                  </span>
                  <div className={cn("min-w-0 flex-1 text-sm font-medium", step.done && "line-through")}>
                    {step.title}
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
                </div>
                {!step.done && (
                  <p className="mt-1 pl-8 text-xs text-muted-foreground">{step.description}</p>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}
