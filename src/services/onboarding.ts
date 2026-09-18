import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import type { Account, OnboardingPath } from "../db/schema";
import { audiences, campaigns, sendingDomains, subscribers } from "../db/schema";
import { checkSendEligibility } from "./plans";
import { accountSandboxMode } from "./sandbox";
import { findSharedDomain } from "./shared-domain";
import { findTeamAudience, teamAudienceSize } from "./team-audience";

// The real, server-computed onboarding state for an account. Drives the
// dashboard checklist and the "why can't I send?" actionable messages so the UI
// never has to infer these facts (or surface a raw API error) on its own.
export type OnboardingState = {
  // Conversion-path checklist (in order).
  billingActive: boolean;
  hasVerifiedDomain: boolean;
  hasSubscribers: boolean;
  // True once the account has subscribers outside the seeded team audience, i.e.
  // an audience the user actually built. See the query for why both exist.
  hasOwnSubscribers: boolean;
  hasCampaign: boolean;
  hasSentCampaign: boolean;
  // Day-one state (docs/dashboard-day-zero-plan.md). `canSendFirstEmail` is the
  // question the first-run dashboard actually asks: is there a working path to a
  // real email right now, without the user setting anything up? That is true
  // when the account has the shared Day3 domain and a team audience with
  // somebody in it (which provisioning gives every new org), and it is what
  // decides whether day zero opens with "send yourself the first one" or with
  // the old verify-a-domain climb.
  hasSharedDomain: boolean;
  teamAudienceId: string | null;
  teamAudienceSize: number;
  canSendFirstEmail: boolean;
  // Which starting path the user said they were on, null until asked (A4).
  onboardingPath: OnboardingPath | null;
  // A physical mailing address is legally required in every email footer, so it's
  // a send gate — surfaced here so the UI greys the Send button with a fix link
  // rather than letting the user hit a raw error only after confirming.
  hasMailingAddress: boolean;
  // Send gating, mirroring the campaign-submit route's checks.
  accountPaused: boolean;
  canSend: boolean;
  // True when sends run in the free tier's sandbox mode: real delivery, but only
  // to the org's own members and on the shared monthly allowance. Distinct from
  // canSend — a sandbox account *can* send, just not to everyone.
  sandbox: boolean;
  // The first blocking reason, if any (null when canSend is true).
  sendBlockedReason: string | null;
};

export async function computeOnboardingState(db: Db, account: Account): Promise<OnboardingState> {
  // The three reads are independent, so they go out together rather than in
  // series. postgres.js pipelines on a single connection, so this is one network
  // wait instead of three even on the web tier's `max: 1` pool — and this runs on
  // nearly every page (the checklist and the "next step" strip), which made those
  // three serial round trips one of the more expensive things in a navigation.
  const [
    [verifiedDomain],
    [{ subscriberCount, ownCount }],
    [campaignCounts],
    sharedDomain,
    teamAudienceId,
  ] = await Promise.all([
    db
      .select({ id: sendingDomains.id })
      .from(sendingDomains)
      .where(
        and(
          eq(sendingDomains.accountId, account.id),
          // The shared Day3 domain is verified by construction and belongs to
          // us, so it must not satisfy "you have verified a sending domain":
          // that step is about the user's own domain, and counting ours would
          // tick a box the user never earned and silently retire the one piece
          // of setup that lets them reach real people.
          eq(sendingDomains.shared, false),
          sql`(${sendingDomains.verificationStatus} = 'verified' OR ${sendingDomains.adminOverrideVerified} = true)`,
        ),
      )
      .limit(1),
    db
      .select({
        subscriberCount: sql<number>`count(*)`.as("subscriberCount"),
        // Subscribers the user actually brought in, excluding the team audience
        // we seeded for them. `hasSubscribers` answers "can a send reach anyone"
        // and must count the team; this answers "have you built an audience yet"
        // and must not. Otherwise the audience step ticks itself on day one and
        // the user is never pointed at the import or the signup form.
        ownCount: sql<number>`count(*) FILTER (WHERE ${audiences.seededTeam} = false)`.as(
          "ownCount",
        ),
      })
      .from(subscribers)
      .innerJoin(audiences, eq(subscribers.audienceId, audiences.id))
      .where(and(eq(audiences.accountId, account.id), eq(subscribers.status, "subscribed"))),
    db
      .select({
        total: sql<number>`count(*)`.as("total"),
        sent: sql<number>`count(*) FILTER (WHERE ${campaigns.status} = 'sent')`.as("sent"),
      })
      .from(campaigns)
      .where(eq(campaigns.accountId, account.id)),
    findSharedDomain(db, account.id),
    findTeamAudience(db, account.id),
  ]);

  const eligibility = checkSendEligibility(account);
  const sandbox = accountSandboxMode(account);
  const hasVerifiedDomain = !!verifiedDomain;
  const hasSubscribers = Number(subscriberCount) > 0;
  const hasOwnSubscribers = Number(ownCount) > 0;
  const hasMailingAddress = !!account.companyAddress?.trim();

  // The day-one path: a pre-verified Day3 domain plus a team audience with
  // somebody in it. Both are provisioned with the account, so this is normally
  // true from the first second, and when it is the first send needs no domain,
  // no import, and no mailing address (the shared domain carries Day3's own).
  // `eligibility` is included because a past-due, paused or allowance-exhausted
  // account has no path to any email, shared domain or not. Offering one would
  // be a button that fails when pressed.
  const hasSharedDomain = sharedDomain !== null;
  const teamSize = teamAudienceId ? await teamAudienceSize(db, account.id, teamAudienceId) : 0;
  const canSendFirstEmail = hasSharedDomain && teamSize > 0 && eligibility.allowed;

  // The first concrete thing stopping a send, in the order a user must fix them.
  // Mirrors the real gate order (plan eligibility, then campaignSendGateError:
  // mailing address → verified domain → subscribers) so a user never sees the
  // Send button enabled and then fails on a gate that was knowable up front.
  //
  // The mailing-address and verified-domain steps are skipped while the account
  // still has the day-one path open: on the shared domain neither is required,
  // so naming them as blockers would be false. They come back the moment the
  // user wants to reach somebody outside their own team, which is exactly when
  // they become true.
  let sendBlockedReason: string | null = null;
  if (!eligibility.allowed) {
    sendBlockedReason = eligibility.reason;
  } else if (!hasMailingAddress && !canSendFirstEmail) {
    sendBlockedReason =
      "Add your business mailing address in Settings. It's legally required in every email.";
  } else if (!hasVerifiedDomain && !canSendFirstEmail) {
    sendBlockedReason = "Verify a sending domain before you can send.";
  } else if (!hasSubscribers) {
    sendBlockedReason = "Import subscribers before you can send.";
  }

  return {
    billingActive: account.subscriptionStatus === "active",
    hasVerifiedDomain,
    hasSubscribers,
    hasOwnSubscribers,
    hasCampaign: Number(campaignCounts?.total ?? 0) > 0,
    hasSentCampaign: Number(campaignCounts?.sent ?? 0) > 0,
    hasSharedDomain,
    teamAudienceId,
    teamAudienceSize: teamSize,
    canSendFirstEmail,
    onboardingPath: account.onboardingPath ?? null,
    hasMailingAddress,
    // Sandbox accounts have sendingEnabled false by design — that's the plan, not
    // a pause. Only a real stop counts here.
    accountPaused: account.riskStatus === "paused" || (!account.sendingEnabled && !sandbox),
    canSend: sendBlockedReason === null,
    sandbox,
    sendBlockedReason,
  };
}
