import type { Account } from "../db/schema";
import { planCanSend } from "../lib/plans-catalog";

// The plan catalog and all pure plan/lifecycle helpers live in lib/plans-catalog
// (dependency-free so client components can import them too). This module
// re-exports them and adds the server-only send-eligibility check, which needs the
// Account row shape. Existing imports from "@/services/plans" keep working.
export * from "../lib/plans-catalog";

export type SendEligibility =
  | { allowed: true }
  | { allowed: false; reason: string };

// The single send gate, shared by the campaign submit/schedule/resume routes and
// the onboarding state. Order matters: payment problems first (most actionable),
// then risk pause, then the monthly bandwidth cap (the upgrade trigger).
export function checkSendEligibility(account: Account): SendEligibility {
  if (account.subscriptionStatus === "past_due") {
    return {
      allowed: false,
      reason: "Your payment is past due. Update your billing to resume sending.",
    };
  }
  if (account.subscriptionStatus !== "active") {
    return { allowed: false, reason: "Subscription is not active." };
  }
  if (!account.sendingEnabled) {
    // Distinguish the two reasons a send is disabled: a risk pause (admin/health)
    // versus simply being on the set-up-only free tier (needs an upgrade).
    if (account.riskStatus === "paused" || account.pausedReason) {
      return {
        allowed: false,
        reason: account.pausedReason
          ? `Sending is paused: ${account.pausedReason}`
          : "Sending is paused for this account.",
      };
    }
    if (!planCanSend(account.plan)) {
      return {
        allowed: false,
        reason: "The Free plan can't send emails. Subscribe to a paid plan to start sending.",
      };
    }
    return { allowed: false, reason: "Sending is not enabled for this account." };
  }
  if (account.monthlyEmailSentCount >= account.monthlyEmailLimit) {
    return {
      allowed: false,
      reason: "You've reached your plan's monthly email limit. Upgrade your plan to send more.",
    };
  }
  return { allowed: true };
}
