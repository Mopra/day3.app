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

import type { Account } from "../db/schema";

export type SendEligibility =
  | { allowed: true }
  | { allowed: false; reason: string };

export function checkSendEligibility(account: Account): SendEligibility {
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
