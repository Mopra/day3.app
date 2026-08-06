import type { Account } from "../db/schema";
import {
  accountSandboxMode,
  SANDBOX_EXHAUSTED_MESSAGE,
  SANDBOX_MONTHLY_ALLOWANCE,
} from "./sandbox";

// The plan catalog and all pure plan/lifecycle helpers live in lib/plans-catalog
// (dependency-free so client components can import them too). This module
// re-exports them and adds the server-only send-eligibility check, which needs the
// Account row shape. Existing imports from "@/services/plans" keep working.
export * from "../lib/plans-catalog";

export type SendEligibility =
  // `sandbox` is the *mode* the send will run in, not a second permission: true
  // means the free tier's carve-out (org members only, shared 100/month
  // allowance — see services/sandbox.ts). Callers that persist or meter a send
  // must carry it through; callers that only ask "may I?" can ignore it.
  | { allowed: true; sandbox: boolean }
  | { allowed: false; reason: string };

// The single send gate, shared by the campaign submit/schedule/resume routes and
// the onboarding state. Order matters: payment problems first (most actionable),
// then risk pause, then the plan's own ceiling (the upgrade trigger).
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

  // A risk pause outranks everything below, including the sandbox: it is the
  // deliberate "stop sending" lever (admin action, or an automatic health
  // trip), and a free org can trip it exactly like a paid one. Checked before
  // the free-tier branch so a paused free account can't sandbox its way around
  // the pause. Note this deliberately reads riskStatus/pausedReason rather than
  // sendingEnabled, which is false on the free tier by design.
  if (account.riskStatus === "paused" || (!account.sendingEnabled && account.pausedReason)) {
    return {
      allowed: false,
      reason: account.pausedReason
        ? `Sending is paused: ${account.pausedReason}`
        : "Sending is paused for this account.",
    };
  }

  // The free tier sends in sandbox mode instead of not at all: real delivery,
  // but only to the org's own members and only on the shared monthly allowance.
  // The recipient restriction is enforced per-surface (it needs the recipient
  // list); the allowance is checked here so the UI can grey the Send button with
  // a reason rather than failing at send time.
  if (accountSandboxMode(account)) {
    if (account.monthlyEmailSentCount >= SANDBOX_MONTHLY_ALLOWANCE) {
      return { allowed: false, reason: SANDBOX_EXHAUSTED_MESSAGE };
    }
    return { allowed: true, sandbox: true };
  }

  if (!account.sendingEnabled) {
    return { allowed: false, reason: "Sending is not enabled for this account." };
  }
  if (account.monthlyEmailSentCount >= account.monthlyEmailLimit) {
    return {
      allowed: false,
      reason: "You've reached your plan's monthly email limit. Upgrade your plan to send more.",
    };
  }
  return { allowed: true, sandbox: false };
}
