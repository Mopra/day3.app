import type { Account } from "../db/schema";

export const PLANS = {
  none: {
    monthlyEmailLimit: 0,
    sendingEnabled: false,
  },
  tiny: {
    monthlyEmailLimit: 10_000,
    sendingEnabled: true,
  },
} as const;

export type PlanKey = keyof typeof PLANS;

export function isPlanKey(value: string): value is PlanKey {
  return value in PLANS;
}

// The Clerk Billing plan slug for the paid plan. Must match the plan configured
// in the Clerk dashboard. Centralized here (with the slug -> plan mapping below)
// so the webhook, the session sync, and tests all agree on a single source.
export const PAID_PLAN_SLUG = "tiny";

// Maps a Clerk Billing plan slug to a local plan key. An unknown or missing slug
// (no subscription, or a plan we do not recognize) resolves to "none".
export function planFromSlug(slug: string | null | undefined): PlanKey {
  return slug && isPlanKey(slug) && slug === PAID_PLAN_SLUG ? "tiny" : "none";
}

export function monthlyEmailLimitForPlan(plan: PlanKey): number {
  return PLANS[plan].monthlyEmailLimit;
}

// The subscription lifecycle states we react to. These mirror the three Clerk
// Billing webhook events (subscriptionItem.active / .pastDue / .ended) and are
// the only inputs that drive subscriptionStatus + sendingEnabled.
export type SubscriptionLifecycle = "active" | "past_due" | "ended";

// The local subscription_status column values. Only "active" permits sending;
// "past_due" and "ended" both block it but are surfaced differently in the UI.
export type SubscriptionStatus = "active" | "past_due" | "inactive";

const LIFECYCLE_STATUS: Record<SubscriptionLifecycle, SubscriptionStatus> = {
  active: "active",
  past_due: "past_due",
  ended: "inactive",
};

export function subscriptionStatusForLifecycle(
  lifecycle: SubscriptionLifecycle,
): SubscriptionStatus {
  return LIFECYCLE_STATUS[lifecycle];
}

// Deterministic entitlements for a (plan, lifecycle) pair. This is the single
// place that decides what subscriptionStatus / monthlyEmailLimit / sendingEnabled
// a billing event yields. Sending is only ever enabled for an active
// subscription on a plan that allows it; a risk-paused account never re-enables.
export function entitlementsFor(
  plan: PlanKey,
  lifecycle: SubscriptionLifecycle,
  opts: { riskPaused: boolean } = { riskPaused: false },
): {
  plan: PlanKey;
  subscriptionStatus: SubscriptionStatus;
  monthlyEmailLimit: number;
  sendingEnabled: boolean;
} {
  const active = lifecycle === "active";
  return {
    plan,
    subscriptionStatus: subscriptionStatusForLifecycle(lifecycle),
    monthlyEmailLimit: monthlyEmailLimitForPlan(plan),
    sendingEnabled: PLANS[plan].sendingEnabled && active && !opts.riskPaused,
  };
}

export type SendEligibility =
  | { allowed: true }
  | { allowed: false; reason: string };

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
    return {
      allowed: false,
      reason: account.pausedReason
        ? `Sending is paused: ${account.pausedReason}`
        : "Sending is not enabled for this account.",
    };
  }
  if (account.monthlyEmailSentCount >= account.monthlyEmailLimit) {
    return { allowed: false, reason: "Monthly email limit reached." };
  }
  return { allowed: true };
}
