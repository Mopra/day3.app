import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { Account } from "../db/schema";
import { audiences, campaigns, sendingDomains, subscribers } from "../db/schema";
import { checkSendEligibility } from "./plans";

// The real, server-computed onboarding state for an account. Drives the
// dashboard checklist and the "why can't I send?" actionable messages so the UI
// never has to infer these facts (or surface a raw API error) on its own.
export type OnboardingState = {
  // Conversion-path checklist (in order).
  billingActive: boolean;
  hasVerifiedDomain: boolean;
  hasSubscribers: boolean;
  hasCampaign: boolean;
  hasSentCampaign: boolean;
  // A physical mailing address is legally required in every email footer, so it's
  // a send gate — surfaced here so the UI greys the Send button with a fix link
  // rather than letting the user hit a raw error only after confirming.
  hasMailingAddress: boolean;
  // Send gating, mirroring the campaign-submit route's checks.
  accountPaused: boolean;
  canSend: boolean;
  // The first blocking reason, if any (null when canSend is true).
  sendBlockedReason: string | null;
};

export async function computeOnboardingState(db: Db, account: Account): Promise<OnboardingState> {
  const [verifiedDomain] = await db
    .select({ id: sendingDomains.id })
    .from(sendingDomains)
    .where(
      and(
        eq(sendingDomains.accountId, account.id),
        sql`(${sendingDomains.verificationStatus} = 'verified' OR ${sendingDomains.adminOverrideVerified} = true)`,
      ),
    )
    .limit(1);

  const [{ subscriberCount }] = await db
    .select({ subscriberCount: sql<number>`count(*)`.as("subscriberCount") })
    .from(subscribers)
    .innerJoin(audiences, eq(subscribers.audienceId, audiences.id))
    .where(and(eq(audiences.accountId, account.id), eq(subscribers.status, "subscribed")));

  const [campaignCounts] = await db
    .select({
      total: sql<number>`count(*)`.as("total"),
      sent: sql<number>`count(*) FILTER (WHERE ${campaigns.status} = 'sent')`.as("sent"),
    })
    .from(campaigns)
    .where(eq(campaigns.accountId, account.id));

  const eligibility = checkSendEligibility(account);
  const hasVerifiedDomain = !!verifiedDomain;
  const hasSubscribers = Number(subscriberCount) > 0;
  const hasMailingAddress = !!account.companyAddress?.trim();

  // The first concrete thing stopping a send, in the order a user must fix them.
  // Mirrors the real gate order (plan eligibility, then campaignSendGateError:
  // mailing address → verified domain → subscribers) so a user never sees the
  // Send button enabled and then fails on a gate that was knowable up front.
  let sendBlockedReason: string | null = null;
  if (!eligibility.allowed) {
    sendBlockedReason = eligibility.reason;
  } else if (!hasMailingAddress) {
    sendBlockedReason =
      "Add your business mailing address in Settings — it's legally required in every email.";
  } else if (!hasVerifiedDomain) {
    sendBlockedReason = "Verify a sending domain before you can send.";
  } else if (!hasSubscribers) {
    sendBlockedReason = "Import subscribers before you can send.";
  }

  return {
    billingActive: account.subscriptionStatus === "active",
    hasVerifiedDomain,
    hasSubscribers,
    hasCampaign: Number(campaignCounts?.total ?? 0) > 0,
    hasSentCampaign: Number(campaignCounts?.sent ?? 0) > 0,
    hasMailingAddress,
    accountPaused: account.riskStatus === "paused" || !account.sendingEnabled,
    canSend: sendBlockedReason === null,
    sendBlockedReason,
  };
}
