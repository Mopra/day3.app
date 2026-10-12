// Review trust: how often the AI pass reviews a new transactional content shape.
//
// The AI pass is the expensive half of content review (services/content-review.ts).
// For an ESTABLISHED sender it is also the half with the least to do: isBlocking
// never lets an AI or keyword verdict refuse an established sender's
// transactional mail, so on those accounts the model only feeds the admin queue.
// Paying for it on every new shape (Exit1.dev alone produced ~1,400 shapes a
// month, one per monitored site) buys monitoring, not protection.
//
// So trust is earned, and trusted accounts are SAMPLED rather than skipped:
//
//   new      inside the new-account ramp, or not enough clean history yet.
//            Every new shape gets the AI pass.
//   watch    something went wrong recently: a phishing pair (hard block) in
//            the lookback window, a PATTERN of high/blocked verdicts in it (at
//            least TRUST_WATCH_MIN_FLAGGED, at TRUST_WATCH_FLAG_RATE or more of
//            the window's AI reviews), a reputation warning, or a risk-paused
//            account. Every new shape gets the AI pass until the window is clean.
//   trusted  out of the ramp, enough delivered mail, enough AI-clean reviews,
//            no watch condition, reputation normal. One new shape in
//            TRUSTED_SAMPLE_EVERY gets the AI pass.
//
// Why a pattern and not "any flag": the model has a false-positive floor. An
// honest uptime monitor (Exit1.dev) drew 4 `high` verdicts in ~500 AI reviews
// in one week, every one an SSL or downtime alert. "Any high in 30 days" kept
// it in `watch` forever and the feature saved nothing. A phishing pair is the
// deterministic floor, not a guess, so one of those is always enough.
//
// What trust NEVER changes:
//   - The deterministic checks run on every send, whatever the tier. They are
//     what refuses a phishing pair, and they are free.
//   - Campaigns and automations are reviewed in full, always. One call per
//     campaign is cheap, and an AI `blocked` verdict still stops a campaign.
//   - A sampled-out shape is not approved for good: its row is stored with
//     ai_review = 'sampled_out', and if the account later drops out of
//     `trusted`, the next send of that shape is reviewed by the AI.
//   - Any flagged verdict invalidates the cached trust, so the account is
//     re-evaluated against the rules above: immediately in the process that
//     stored the verdict, and within TRUST_CACHE_TTL_MS (10 minutes) in every
//     other process, whose own caches simply expire. A phishing pair demotes on
//     that re-evaluation; AI flags demote once they form a pattern.
//
// This module must not import content-review.ts (which imports it). The ramp
// check therefore goes straight to send-ramp.ts rather than through isUnderRamp.
import { randomInt } from "node:crypto";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  campaignRecipients,
  contentReviews,
  transactionalEmails,
  type Account,
} from "../db/schema";
import { computeAccountHealth } from "./health";
import { rampDailyLimit } from "./send-ramp";

export type ReviewTrustTier = "new" | "watch" | "trusted";

export type ReviewTrust = {
  tier: ReviewTrustTier;
  /** 1 = every new shape is AI-reviewed; TRUSTED_SAMPLE_EVERY = one in that many. */
  sampleEvery: number;
  /** Plain-language reasons for the tier, shown to operators in the admin UI. */
  reasons: string[];
  stats: {
    /** Delivered emails counted toward trust, capped at TRUST_MIN_DELIVERED. */
    deliveredCapped: number;
    /** content_reviews rows with ai_review = 'reviewed' and risk low/medium. */
    aiClean: number;
    /** Newest high/blocked/hard-block content review in the lookback window. */
    lastFlaggedAt: string | null;
  };
  computedAt: string;
};

// Thresholds. These are product decisions; AGENTS.md rule 6 and
// docs/review-trust.md restate them, so move them together.
export const TRUST_MIN_DELIVERED = 1_000;
export const TRUST_MIN_AI_CLEAN = 25;
export const TRUST_LOOKBACK_DAYS = 30;
export const TRUSTED_SAMPLE_EVERY = 10;
/** Flagged (high/blocked) reviews in the window before a pattern can demote. */
export const TRUST_WATCH_MIN_FLAGGED = 3;
/** Share of the window's AI reviews that must be flagged to demote. */
export const TRUST_WATCH_FLAG_RATE = 0.05;
/**
 * Per-process cache of computed trust. Invalidated on any flagged verdict in
 * the process that stored it; other processes pick it up when this expires.
 */
export const TRUST_CACHE_TTL_MS = 10 * 60 * 1000;

// Ledger statuses that mean the mail reached a mailbox. `bounced` did not, and
// `complained` did but is nothing to build trust on.
const DELIVERED_RECIPIENT_STATUSES = ["sent", "delivered", "unsubscribed"] as const;
const DELIVERED_TX_STATUSES = ["sent", "delivered"] as const;

const fmt = (n: number) => n.toLocaleString("en-US");

// Per-process cache. Each worker replica keeps its own: the TTL bounds how long
// a demotion seen elsewhere takes to land here, and invalidateReviewTrust makes
// a demotion seen HERE immediate.
const cache = new Map<string, { trust: ReviewTrust; expiresAt: number }>();
let warnedOnFailure = false;

// count(*) over a subquery capped with LIMIT, so an account with millions of
// sends costs the same as one with exactly enough: Postgres stops reading at
// the cap.
async function countDelivered(db: Db, accountId: string): Promise<number> {
  const cap = TRUST_MIN_DELIVERED;
  const ledger = db
    .select({ one: sql`1`.as("one") })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.accountId, accountId),
        inArray(campaignRecipients.status, [...DELIVERED_RECIPIENT_STATUSES]),
      ),
    )
    .limit(cap)
    .as("s");
  const [fromLedgerRow] = await db.select({ n: sql<number>`count(*)::int` }).from(ledger);
  const fromLedger = Number(fromLedgerRow?.n ?? 0);
  if (fromLedger >= cap) return cap;

  const tx = db
    .select({ one: sql`1`.as("one") })
    .from(transactionalEmails)
    .where(
      and(
        eq(transactionalEmails.accountId, accountId),
        inArray(transactionalEmails.status, [...DELIVERED_TX_STATUSES]),
      ),
    )
    .limit(cap - fromLedger)
    .as("s");
  const [fromTxRow] = await db.select({ n: sql<number>`count(*)::int` }).from(tx);
  return Math.min(cap, fromLedger + Number(fromTxRow?.n ?? 0));
}

async function countAiClean(db: Db, accountId: string): Promise<number> {
  const clean = db
    .select({ one: sql`1`.as("one") })
    .from(contentReviews)
    .where(
      and(
        eq(contentReviews.accountId, accountId),
        eq(contentReviews.aiReview, "reviewed"),
        inArray(contentReviews.riskLevel, ["low", "medium"]),
      ),
    )
    .limit(TRUST_MIN_AI_CLEAN)
    .as("s");
  const [row] = await db.select({ n: sql<number>`count(*)::int` }).from(clean);
  return Number(row?.n ?? 0);
}

type WindowStats = {
  /** high/blocked rows in the window (hard blocks included). */
  flagged: number;
  /** Rows the AI actually reviewed in the window: the rate's denominator. */
  aiReviewed: number;
  /** Newest high/blocked/hard-block row in the window. */
  lastFlaggedAt: string | null;
  /** Newest hard-block (phishing pair) row in the window. */
  lastHardBlockAt: string | null;
};

const iso = (v: string | null | undefined) => (v ? new Date(v).toISOString() : null);

/**
 * One aggregate over the account's content reviews in the lookback window.
 * Keyed on updated_at, not created_at: a sampled-out row re-reviewed into
 * `high` today is a flag raised today, and a refusal-counter bump means the
 * flagged content is still being sent.
 */
async function windowStats(db: Db, accountId: string, now: Date): Promise<WindowStats> {
  const cutoff = new Date(now.getTime() - TRUST_LOOKBACK_DAYS * 86_400_000).toISOString();
  const flaggedSql = sql`(${contentReviews.riskLevel} in ('high', 'blocked') or ${contentReviews.hardBlock})`;
  const [row] = await db
    .select({
      flagged: sql<number>`(count(*) filter (where ${contentReviews.riskLevel} in ('high', 'blocked')))::int`,
      aiReviewed: sql<number>`(count(*) filter (where ${contentReviews.aiReview} = 'reviewed'))::int`,
      lastFlaggedAt: sql<string | null>`max(${contentReviews.updatedAt}) filter (where ${flaggedSql})`,
      lastHardBlockAt: sql<string | null>`max(${contentReviews.updatedAt}) filter (where ${contentReviews.hardBlock})`,
    })
    .from(contentReviews)
    .where(and(eq(contentReviews.accountId, accountId), gte(contentReviews.updatedAt, cutoff)));
  return {
    flagged: Number(row?.flagged ?? 0),
    aiReviewed: Number(row?.aiReviewed ?? 0),
    lastFlaggedAt: iso(row?.lastFlaggedAt),
    lastHardBlockAt: iso(row?.lastHardBlockAt),
  };
}

/**
 * Whether the window's flags form a pattern. A few `high` verdicts among
 * hundreds of clean ones is the model's false-positive floor, not a signal.
 * With no AI reviews in the window there is no rate to take, so the count
 * alone decides.
 */
function flagPattern(w: WindowStats): string | null {
  if (w.flagged < TRUST_WATCH_MIN_FLAGGED) return null;
  if (w.aiReviewed === 0) {
    return `${fmt(w.flagged)} content reviews flagged in the last ${TRUST_LOOKBACK_DAYS} days`;
  }
  const rate = w.flagged / w.aiReviewed;
  if (rate < TRUST_WATCH_FLAG_RATE) return null;
  return (
    `${fmt(w.flagged)} of ${fmt(w.aiReviewed)} AI reviews flagged in the last ` +
    `${TRUST_LOOKBACK_DAYS} days (${Math.round(rate * 100)}%)`
  );
}

async function computeReviewTrust(db: Db, account: Account, now: Date): Promise<ReviewTrust> {
  const [health, win, deliveredCapped, aiClean] = await Promise.all([
    computeAccountHealth(db, account.id),
    windowStats(db, account.id, now),
    countDelivered(db, account.id),
    countAiClean(db, account.id),
  ]);
  const stats = { deliveredCapped, aiClean, lastFlaggedAt: win.lastFlaggedAt };
  const computedAt = now.toISOString();

  const watch: string[] = [];
  if (account.riskStatus !== "normal") {
    watch.push(`Account risk status is ${account.riskStatus}`);
  }
  if (health.status !== "normal") {
    watch.push(`Sending reputation is at ${health.status}` + (health.reason ? `: ${health.reason}` : ""));
  }
  if (win.lastHardBlockAt) {
    watch.push(`A phishing pair was refused on ${win.lastHardBlockAt.slice(0, 10)}`);
  }
  const pattern = flagPattern(win);
  if (pattern) watch.push(pattern);
  if (watch.length > 0) {
    return { tier: "watch", sampleEvery: 1, reasons: watch, stats, computedAt };
  }

  const fresh: string[] = [];
  if (rampDailyLimit(account, now) !== null) fresh.push("Still inside the new-account period");
  if (deliveredCapped < TRUST_MIN_DELIVERED) {
    fresh.push(`${fmt(deliveredCapped)} of ${fmt(TRUST_MIN_DELIVERED)} delivered emails`);
  }
  if (aiClean < TRUST_MIN_AI_CLEAN) {
    fresh.push(`${fmt(aiClean)} of ${fmt(TRUST_MIN_AI_CLEAN)} clean AI reviews`);
  }
  if (fresh.length > 0) {
    return { tier: "new", sampleEvery: 1, reasons: fresh, stats, computedAt };
  }

  return {
    tier: "trusted",
    sampleEvery: TRUSTED_SAMPLE_EVERY,
    reasons: [
      "Out of the new-account period",
      `${fmt(TRUST_MIN_DELIVERED)}+ delivered emails and ${fmt(TRUST_MIN_AI_CLEAN)}+ clean AI reviews`,
      `No phishing pair or pattern of flagged reviews in the last ${TRUST_LOOKBACK_DAYS} days, and reputation is normal`,
    ],
    stats,
    computedAt,
  };
}

/**
 * Computes (or returns the cached) review trust for an account.
 *
 * Fails SAFE toward reviewing: if anything here throws, the account is treated
 * as `new` and every shape gets the AI pass. Reviewing too much costs cents;
 * skipping wrongly costs safety. A failed computation is not cached, so the next
 * send tries again.
 */
export async function getReviewTrust(
  db: Db,
  account: Account,
  now: Date = new Date(),
): Promise<ReviewTrust> {
  const hit = cache.get(account.id);
  if (hit && hit.expiresAt > now.getTime()) return hit.trust;
  if (hit) cache.delete(account.id);

  try {
    const trust = await computeReviewTrust(db, account, now);
    cache.set(account.id, { trust, expiresAt: now.getTime() + TRUST_CACHE_TTL_MS });
    return trust;
  } catch (err) {
    if (!warnedOnFailure) {
      warnedOnFailure = true;
      console.warn("[review-trust] computing trust failed; reviewing every shape:", err);
    }
    return {
      tier: "new",
      sampleEvery: 1,
      reasons: ["Trust could not be computed, so every new shape is reviewed"],
      stats: { deliveredCapped: 0, aiClean: 0, lastFlaggedAt: null },
      computedAt: now.toISOString(),
    };
  }
}

/** Drops the cached trust for an account (call after storing a flagged verdict). */
export function invalidateReviewTrust(accountId: string): void {
  cache.delete(accountId);
}

/** Empties the whole per-process cache. For tests. */
export function resetReviewTrustCache(): void {
  cache.clear();
}

const RANDOM_SCALE = 1_000_000;
const cryptoRandom = () => randomInt(0, RANDOM_SCALE) / RANDOM_SCALE;

/** Whether this new shape should get the AI pass. `random` is injectable for tests. */
export function shouldRunAiReview(
  trust: ReviewTrust,
  random: () => number = cryptoRandom,
): boolean {
  if (trust.sampleEvery <= 1) return true;
  return random() < 1 / trust.sampleEvery;
}
