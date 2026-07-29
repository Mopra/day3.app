// Plan catalog — the single source of truth for Day3's pricing tiers.
//
// Day3 sells *sending bandwidth*, not features: every product feature is
// available on every tier. A plan is therefore just a monthly email allowance at
// a price. The plan key IS the Clerk Billing plan slug (configured in the Clerk
// dashboard), so the webhook, the session sync, the UI, and the tests all key off
// the same string.
//
// This module is intentionally dependency-free (no db / server imports) so client
// components can import the catalog and the upgrade-path helpers directly. The
// server-only send-eligibility check lives in services/plans.ts, which re-exports
// everything here.

export type PlanMeta = {
  /** Human label shown in the UI (e.g. "5k"). */
  name: string;
  /** Hard monthly send cap, enforced atomically at send time. 0 = cannot send. */
  monthlyEmailLimit: number;
  /** Monthly price in USD. 0 for the free tier. */
  monthlyPriceUsd: number;
  /** Whether the tier may send email at all. The free tier is set-up-only. */
  sendingEnabled: boolean;
  /**
   * AI assist allowance in credits (1 credit = $0.01 of metered AI spend), for
   * the visible rolling window. **0 means the tier has no AI at all** — it is
   * what `planHasAI` keys off. Every paid tier gets at least a taste: the AI
   * composer is the product's differentiator, so hiding it entirely from the
   * cheap tiers means most trial users never see it. The small tiers get a
   * starter allowance; 10k and up get the full one.
   */
  aiWindowCredits: number;
  /** AI credits per calendar month — the silent backstop behind the window. */
  aiMonthlyCredits: number;
  /**
   * Max subscribers an account on this tier may store (spam/abuse protection on
   * the free tier so set-up-only accounts can't hoard a giant list). null =
   * unlimited (paid tiers).
   */
  maxSubscribers: number | null;
};

// Ordered cheapest → most generous. The free tier is first (set-up + drafts only,
// no sending); every paid tier sends and every paid tier includes the AI
// assistant — the cheap tiers on a smaller allowance. Keep in sync with the Clerk
// dashboard plans and PRODUCT.md.
//
// The AI allowance is a real cost, so it is sized against the tier's price: the
// monthly credits are the worst case an org can burn (1k = $0.20 of a $1 plan,
// 5k = $0.50 of $3, 10k = $1.00 of $5, 25k+ = $2.00). Raising these directly cuts
// the tier's margin — the cheap tiers are thin enough that a full AI month is the
// difference between a healthy and a marginal customer, which is why the
// allowance climbs with the price rather than being flat above some threshold.
//
// Pricing note: the ladder is deliberately close to cost. Delivery is SES at
// $0.10/1k and is perfectly linear, so there are no volume economies to pass on —
// the per-1k price flattens out around $0.22-0.30 rather than falling away, and
// the cheap tiers sit *above* that line only because Stripe's fixed ~$0.30 per
// charge dominates a $1-3 price. Read the ladder as ~55-70% gross margin
// throughout; cutting any tier further eats directly into that.
export const PLANS = {
  free_org: { name: "Free", monthlyEmailLimit: 0, monthlyPriceUsd: 0, sendingEnabled: false, aiWindowCredits: 0, aiMonthlyCredits: 0, maxSubscribers: 500 },
  "1k_plan": { name: "1k", monthlyEmailLimit: 1_000, monthlyPriceUsd: 1, sendingEnabled: true, aiWindowCredits: 10, aiMonthlyCredits: 20, maxSubscribers: null },
  "5k_plan": { name: "5k", monthlyEmailLimit: 5_000, monthlyPriceUsd: 3, sendingEnabled: true, aiWindowCredits: 15, aiMonthlyCredits: 50, maxSubscribers: null },
  "10k_plan": { name: "10k", monthlyEmailLimit: 10_000, monthlyPriceUsd: 5, sendingEnabled: true, aiWindowCredits: 20, aiMonthlyCredits: 100, maxSubscribers: null },
  "25k_plan": { name: "25k", monthlyEmailLimit: 25_000, monthlyPriceUsd: 8, sendingEnabled: true, aiWindowCredits: 30, aiMonthlyCredits: 200, maxSubscribers: null },
  "50k_plan": { name: "50k", monthlyEmailLimit: 50_000, monthlyPriceUsd: 14, sendingEnabled: true, aiWindowCredits: 30, aiMonthlyCredits: 200, maxSubscribers: null },
  "100k_plan": { name: "100k", monthlyEmailLimit: 100_000, monthlyPriceUsd: 25, sendingEnabled: true, aiWindowCredits: 30, aiMonthlyCredits: 200, maxSubscribers: null },
  "250k_plan": { name: "250k", monthlyEmailLimit: 250_000, monthlyPriceUsd: 60, sendingEnabled: true, aiWindowCredits: 30, aiMonthlyCredits: 200, maxSubscribers: null },
  "500k_plan": { name: "500k", monthlyEmailLimit: 500_000, monthlyPriceUsd: 115, sendingEnabled: true, aiWindowCredits: 30, aiMonthlyCredits: 200, maxSubscribers: null },
  "1m_plan": { name: "1M", monthlyEmailLimit: 1_000_000, monthlyPriceUsd: 220, sendingEnabled: true, aiWindowCredits: 30, aiMonthlyCredits: 200, maxSubscribers: null },
} as const satisfies Record<string, PlanMeta>;

export type PlanKey = keyof typeof PLANS;

// The default tier for every new or unsubscribed org. All set-up features and
// drafts, always active, but no sending (and no AI) until they subscribe.
export const FREE_PLAN: PlanKey = "free_org";

// Plan keys in catalog order (free → the top tier). Drives the pricing grid and
// the "next tier up" upgrade suggestion.
export const PLAN_ORDER = [
  "free_org",
  "1k_plan",
  "5k_plan",
  "10k_plan",
  "25k_plan",
  "50k_plan",
  "100k_plan",
  "250k_plan",
  "500k_plan",
  "1m_plan",
] as const satisfies readonly PlanKey[];

// The most generous self-serve tier — the ceiling of the ladder. Above it there
// is no checkout, only the "contact us" card, so UI copy derives its numbers from
// here instead of hardcoding them (they drifted last time the ladder moved).
export const TOP_PLAN: PlanKey = PLAN_ORDER[PLAN_ORDER.length - 1];

// Paid tiers only, most generous first, so an overlapping set of Clerk grants
// resolves to the highest tier the org holds.
const PAID_PLANS_DESC: PlanKey[] = PLAN_ORDER.filter((p) => p !== FREE_PLAN).reverse();

export function isPlanKey(value: string): value is PlanKey {
  return value in PLANS;
}

export function planMeta(plan: PlanKey): PlanMeta {
  return PLANS[plan];
}

// The label for a plan key, tolerant of an unknown/legacy value stored on a row.
export function planLabel(plan: string): string {
  return isPlanKey(plan) ? PLANS[plan].name : plan;
}

// Maps a Clerk Billing plan slug to a local plan key. The slug IS the key; an
// unknown or missing slug (no recognizable subscription) resolves to the free tier.
export function planFromSlug(slug: string | null | undefined): PlanKey {
  return slug && isPlanKey(slug) ? slug : FREE_PLAN;
}

// --- Clerk/catalog agreement ------------------------------------------------
// The plan keys here ARE the Clerk Billing slugs, so a typo in the Clerk
// dashboard (`1M_plan` for `1m_plan`) is invisible to the type system and fails
// in the worst possible way: nothing errors, the tier simply stops resolving and
// the org silently reads as Free. These two helpers make that state detectable.

// True when Clerk handed us a slug this catalog doesn't have. Distinguishes "this
// org has no subscription" (absent slug) from "the Clerk dashboard and this
// catalog disagree" — the second is an operator bug, never a downgrade.
export function isUnknownPlanSlug(slug: string | null | undefined): boolean {
  return typeof slug === "string" && slug.length > 0 && !isPlanKey(slug);
}

// The paid tiers this catalog sells that Clerk has no plan for, given the slugs
// Clerk reports. Non-empty means checkout is dead for those tiers and any org
// holding one resolves to Free — always a misconfiguration. The free tier is
// excluded: it is the default and deliberately has no Clerk plan behind it.
export function missingClerkPlanSlugs(clerkSlugs: readonly string[]): PlanKey[] {
  const available = new Set(clerkSlugs);
  return PLAN_ORDER.filter((plan) => plan !== FREE_PLAN && !available.has(plan));
}

// Resolves the plan an org currently holds from the session billing claims
// (Clerk's `has({ plan })`). Checks paid tiers from most to least generous and
// falls back to the free tier when none are held.
export function planFromEntitlements(
  has: (params: { plan: string }) => boolean,
): PlanKey {
  for (const plan of PAID_PLANS_DESC) {
    if (has({ plan: `org:${plan}` })) return plan;
  }
  return FREE_PLAN;
}

// --- Manual tier override (testers) -----------------------------------------
// A Clerk organization's publicMetadata may carry a `plan` key that forces the
// org onto that tier regardless of its real billing state — the manual override
// used to put testers on a paid tier without a subscription. Set it in the Clerk
// dashboard (Organization → Metadata → Public), e.g. { "plan": "25k_plan" }.
//
// Organization publicMetadata is writable only from the Clerk Backend API or the
// dashboard — org members cannot set it from the client — so this is not a
// self-serve upgrade path. An absent / unrecognized value returns null, meaning
// real billing applies.
export const TIER_OVERRIDE_METADATA_KEY = "plan";

export function planOverrideFromMetadata(metadata: unknown): PlanKey | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[TIER_OVERRIDE_METADATA_KEY];
  return typeof value === "string" && isPlanKey(value) ? value : null;
}

export function monthlyEmailLimitForPlan(plan: PlanKey): number {
  return PLANS[plan].monthlyEmailLimit;
}

// Whether a tier can send email at all (false for the set-up-only free tier).
// Tolerant of an unknown/legacy stored value (treated as non-sending).
export function planCanSend(plan: string): boolean {
  return isPlanKey(plan) && PLANS[plan].sendingEnabled;
}

// Whether the AI writing assistant is available on a tier. Every paid tier has
// it; only the free tier (and an unknown/legacy value) does not.
export function planHasAI(plan: string): boolean {
  return isPlanKey(plan) && PLANS[plan].aiWindowCredits > 0;
}

// The AI credit allowance a tier carries — the input to the budget meter and to
// the enforcement in lib/ai-budget. An unknown/legacy plan falls back to the free
// tier's (no AI), matching how maxSubscribersForPlan degrades.
export type AiAllowance = {
  /** Credits in the visible rolling window. 0 = no AI on this tier. */
  windowCredits: number;
  /** Credits per calendar month (the silent backstop). 0 = no monthly cap. */
  monthlyCredits: number;
};

export function aiAllowanceForPlan(plan: string): AiAllowance {
  const meta = isPlanKey(plan) ? PLANS[plan] : PLANS[FREE_PLAN];
  return { windowCredits: meta.aiWindowCredits, monthlyCredits: meta.aiMonthlyCredits };
}

// The largest monthly allowance any tier carries. Lets the budget error tell an
// org on a starter allowance that upgrading buys more AI, while staying quiet for
// an org already at the top.
export const MAX_AI_MONTHLY_CREDITS: number = Math.max(
  ...Object.values(PLANS).map((p) => p.aiMonthlyCredits),
);

// Shown both server-side (403 from the AI routes) and client-side (composer
// upgrade button) when an account on a non-AI tier reaches for AI. Only the free
// tier lands here now that every paid tier includes an allowance.
export const AI_UPGRADE_MESSAGE =
  "The AI writing assistant is included on every paid plan. Subscribe to a paid plan to use AI.";

// The subscriber cap for a tier (null = unlimited). Unknown/legacy values fall
// back to the free-tier cap so an unrecognized plan can't hoard subscribers.
export function maxSubscribersForPlan(plan: string): number | null {
  return isPlanKey(plan) ? PLANS[plan].maxSubscribers : PLANS[FREE_PLAN].maxSubscribers;
}

// The cheapest tier that includes the AI assistant — the target of "upgrade to
// unlock AI" CTAs shown to accounts on a non-AI plan.
export function firstAiPlan(): PlanKey {
  return PLAN_ORDER.find((p) => PLANS[p].aiWindowCredits > 0) ?? PLAN_ORDER[PLAN_ORDER.length - 1];
}

// The cheapest tier that can send — the target of "upgrade to start sending" CTAs
// shown to free-tier accounts.
export function firstSendingPlan(): PlanKey {
  return PLAN_ORDER.find((p) => PLANS[p].sendingEnabled) ?? PLAN_ORDER[PLAN_ORDER.length - 1];
}

// The next tier up from the given plan (for upgrade CTAs), or null at the top.
export function nextPlanUp(plan: PlanKey): PlanKey | null {
  const i = PLAN_ORDER.indexOf(plan);
  return i >= 0 && i < PLAN_ORDER.length - 1 ? PLAN_ORDER[i + 1] : null;
}

// The smallest plan whose monthly allowance covers `emails`. Used to recommend
// the right tier from observed/expected volume; falls back to the largest plan
// when nothing is big enough.
export function recommendedPlanFor(emails: number): PlanKey {
  for (const plan of PLAN_ORDER) {
    if (PLANS[plan].monthlyEmailLimit >= emails) return plan;
  }
  return PLAN_ORDER[PLAN_ORDER.length - 1];
}

// --- Subscription lifecycle -------------------------------------------------
// These mirror the three Clerk Billing webhook events
// (subscriptionItem.active / .pastDue / .ended) and are the only inputs that
// drive subscriptionStatus + sendingEnabled.
export type SubscriptionLifecycle = "active" | "past_due" | "ended";

// The local subscription_status column values. "active" permits sending;
// "past_due" blocks it (payment owed) but keeps the plan visible. "inactive" is
// retained for legacy rows — in the bandwidth model a lapsed subscription drops
// to the always-active free tier rather than going inactive.
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

// Deterministic entitlements for a (plan, lifecycle) pair. The single place that
// decides what subscriptionStatus / monthlyEmailLimit / sendingEnabled a billing
// state yields. Sending is only ever enabled for an active lifecycle on a plan
// that allows it; a risk-paused account never re-enables.
//
// Note: a lapsed *paid* subscription is downgraded to the free tier before this
// is called (see services/accounts.ts), so the "ended" lifecycle here only ever
// pairs with a plan we are deliberately disabling.
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
