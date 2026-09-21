"use client";

// The "everything's ready" list shown at the point of no return, in both
// send-confirmation dialogs (the campaign detail page and the new-campaign
// action cluster). One component because two copies drifted into rendering a
// green tick on every row regardless of the underlying flag — which told a
// day-one account it had a "verified sending domain" it had never set up.
//
// Each row states what is actually true. A row that isn't satisfied but also
// isn't blocking (the shared Day3 domain covers the domain and the footer
// address on day one) says what covers it instead, rather than showing a scary
// cross next to a send that is about to work fine.
import { Check, Info } from "lucide-react";
import type { OnboardingState } from "@/lib/types";

type Row = { ok: boolean; label: string };

// The rows for an account's current state, in the order the send gates run.
export function sendReadinessRows(onboarding: OnboardingState): Row[] {
  // The shared Day3 domain is what makes a brand-new org able to send before it
  // has touched DNS: it is pre-verified and its footer carries Day3's own postal
  // address, so neither the domain step nor the address step blocks that send.
  const onSharedPath = !onboarding.hasVerifiedDomain && onboarding.canSendFirstEmail;
  return [
    onboarding.hasVerifiedDomain
      ? { ok: true, label: "Verified sending domain" }
      : onSharedPath
        ? { ok: false, label: "Sending from Day3's shared test address" }
        : { ok: false, label: "No verified sending domain yet" },
    onboarding.hasMailingAddress
      ? { ok: true, label: "Business address on file" }
      : onSharedPath
        ? { ok: false, label: "Day3's postal address in the footer" }
        : { ok: false, label: "No business address on file" },
    onboarding.hasSubscribers
      ? { ok: true, label: "Audience has subscribers" }
      : { ok: false, label: "Audience has no subscribers" },
  ];
}

export function SendReadiness({ onboarding }: { onboarding: OnboardingState }) {
  return (
    <ul className="space-y-1.5 text-sm text-muted-foreground">
      {sendReadinessRows(onboarding).map((row) => (
        <li key={row.label} className="flex items-center gap-2">
          {row.ok ? (
            <Check className="size-4 shrink-0 text-olive" />
          ) : (
            <Info className="size-4 shrink-0 text-muted-foreground/70" />
          )}
          {row.label}
        </li>
      ))}
    </ul>
  );
}
