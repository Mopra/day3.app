// Pre-send safety review for TRANSACTIONAL content (POST /v1/emails).
//
// Campaigns have had an automated review since day one (queue/handlers/
// review-campaign.ts). The public email API did not, and that asymmetry is what
// a phishing run walked through: an attacker who never creates a campaign never
// meets the reviewer. This module closes it WITHOUT adding a second risk engine
// — the verdict comes from the same `reviewCampaignRisk` in services/risk.ts,
// so "which checks ran before this email went out" keeps one answer, exactly as
// AGENTS.md requires of the two campaign front doors.
//
// THE SHAPE PROBLEM. A campaign is one review for one send to many people. The
// transactional API is one request per recipient — 16,000 requests carrying one
// body in a real abuse run, and a few hundred a minute carrying genuinely
// different bodies in normal use. So the unit of review here is the CONTENT,
// not the request:
//
//   1. Deterministic checks run inline on every request. They are pure string
//      work (tens of microseconds), they never call out, and they are what
//      refuses a blocked fingerprint before it is even stored.
//   2. The AI pass runs ONCE per distinct fingerprint, in the worker, off the
//      request path. The first message of a new shape pays a few seconds of
//      delivery latency; every later message with the same shape is one
//      indexed lookup.
//   3. The verdict is cached in `content_reviews` keyed by (account,
//      fingerprint), so a `blocked` verdict earned by message #1 refuses
//      messages #2 through #16,000 for free.
//
// FAIL-OPEN vs FAIL-CLOSED. The AI pass fails OPEN (a model outage must not
// stop a customer's password resets) but the deterministic floor always
// applies, and `blocked` is always terminal. This mirrors reviewCampaignRisk.
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "../db/client";
import { accounts, contentReviews, type Account, type ContentReview } from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { logJob } from "../lib/job-log";
import { logger } from "../lib/logger";
import { htmlToText } from "./risk-ai";
import { rampDailyLimit } from "./send-ramp";
import {
  extractImageSources,
  extractLinks,
  runDeterministicRiskChecks,
  reviewCampaignRisk,
  urlHost,
  type CampaignRiskReview,
  type RiskCheckInput,
} from "./risk";

export type TransactionalContent = {
  subject: string;
  html?: string | null;
  text?: string | null;
  fromEmail: string;
  fromName?: string | null;
  sendingDomain: string;
};

/** Normalises `TransactionalContent` into the shared risk engine's input. */
export function toRiskInput(content: TransactionalContent): RiskCheckInput {
  return {
    subject: content.subject,
    htmlBody: content.html ?? "",
    textBody: content.text ?? null,
    fromEmail: content.fromEmail,
    fromName: content.fromName ?? null,
    sendingDomain: content.sendingDomain,
  };
}

// Everything that varies per recipient but not per campaign-of-abuse, erased
// before hashing. Without this a password-reset email would have a brand new
// fingerprint on every single send (the token differs every time), so the cache
// would never hit, every message would pay an AI review, and the feature would
// be both ruinously expensive and useless. With it, "reset token=abc" and
// "reset token=xyz" are one shape reviewed once.
//
// Erasing MORE than this would be a bypass: an attacker who can push the
// varying part of their payload into a normalised-away position gets a free
// pass. So this only removes things that carry no risk meaning on their own —
// digits, hex/base64-ish blobs, email addresses, and URL query strings. The
// words, the host names, and the structure all survive into the hash.
function normaliseForFingerprint(text: string): string {
  return text
    .toLowerCase()
    // URL query strings and fragments: per-recipient tracking, never content.
    .replace(/([?#])[^\s"'<>]*/g, "$1")
    // Email addresses.
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, "@")
    // Long opaque tokens (hex, base64url, uuids).
    .replace(/[a-z0-9_-]{16,}/g, "*")
    // Any remaining run of digits.
    .replace(/\d+/g, "#")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A stable hash of what this email actually SAYS and WHERE IT POINTS.
 *
 * Built from the From identity, the subject, and the body as plain text — the
 * HTML is stripped first so that re-generating the same email through a
 * different templating pass (different attribute order, different whitespace,
 * a re-minified style block) still lands on one fingerprint.
 */
export function contentFingerprint(content: TransactionalContent): string {
  const html = content.html ?? "";
  const body = htmlToText(html) || (content.text ?? "");

  // WHERE THE EMAIL POINTS IS PART OF WHAT IT IS.
  //
  // `htmlToText` strips tags, so the destination of every link and image
  // disappears from the body text. Hashing only that text would mean an
  // approved verdict covers any email with the same words — and an attacker
  // could take content we already cleared, repoint the button at a credential
  // harvester, and inherit the approval without ever being reviewed again.
  // Hosts are hashed separately (sorted and deduped, so a reordered template is
  // still one shape) while the per-recipient query strings stay normalised away
  // by urlHost dropping them.
  const hosts = [
    ...new Set(
      [...extractLinks(html), ...extractImageSources(html)]
        .map((raw) => urlHost(raw))
        .filter((h): h is string => h !== null),
    ),
  ].sort();

  const material = [
    normaliseForFingerprint(content.fromName ?? ""),
    normaliseForFingerprint(content.fromEmail),
    normaliseForFingerprint(content.subject),
    normaliseForFingerprint(body),
    hosts.join(","),
  ].join("\n\u0000\n");
  return createHash("sha256").update(material, "utf8").digest("hex");
}

/** An account still inside the new-account ramp (services/send-ramp.ts). */
export function isUnderRamp(
  account: Pick<Account, "createdAt" | "rampLiftedAt">,
  now = new Date(),
): boolean {
  return rampDailyLimit(account, now) !== null;
}

/**
 * Does this verdict refuse the send?
 *
 * `blocked` always does. `high` does too, but only while the account is still
 * inside the new-account ramp. Trust is earned: an established customer whose
 * password reset trips a `high` keeps sending and shows up in the admin queue,
 * because breaking their auth flow costs more than the false positive. A
 * two-hour-old workspace has no such history, and `high` on it is much more
 * often what it looks like. The attacker's third account is the case in point:
 * having been blocked on the impersonation pair, he trimmed the content until
 * it scored `high`, and 475 emails went out on that verdict.
 */
export function isBlocking(
  review: Pick<ContentReview, "riskLevel">,
  account?: Pick<Account, "createdAt" | "rampLiftedAt"> | null,
): boolean {
  if (review.riskLevel === "blocked") return true;
  if (review.riskLevel === "high" && account && isUnderRamp(account)) return true;
  return false;
}

/**
 * A `blocked` verdict on an account still inside the ramp pauses the account.
 *
 * A brand-new workspace whose first messages the reviewer refuses as phishing
 * is essentially never a customer who made a mistake. Every one of the three
 * accounts in the September 2026 incident would have been stopped at message #1
 * by this rule alone, and each went on to probe the reviewer with variants
 * until one passed. Pausing on the first block ends the probing, because a
 * paused account is refused before content is even looked at. Established
 * accounts are exempt: they earn a 422 and an admin-queue entry, not a pause.
 *
 * Guarded on `risk_status = 'normal'` so the transition happens once and the
 * audit row is written once. Best-effort: the refusal has already happened.
 */
export async function enforceBlockedVerdict(
  db: Db,
  account: Account,
  review: Pick<ContentReview, "id" | "riskLevel" | "summary" | "subject">,
): Promise<boolean> {
  if (review.riskLevel !== "blocked") return false;
  if (!isUnderRamp(account)) return false;
  if (account.riskStatus !== "normal") return false;

  const subject = review.subject.slice(0, 80);
  const reason =
    "Automated: the pre-send review blocked phishing-like content on a new workspace (\"" +
    subject + "\"). " + review.summary;
  try {
    const flipped = await db
      .update(accounts)
      .set({
        sendingEnabled: false,
        riskStatus: "paused",
        pausedReason: reason,
        updatedAt: nowIso(),
      })
      .where(and(eq(accounts.id, account.id), eq(accounts.riskStatus, "normal")))
      .returning({ id: accounts.id });
    if (flipped.length === 0) return false;

    await logJob(db, {
      jobType: "admin_action",
      entityType: "account",
      entityId: account.id,
      status: "completed",
      payload: {
        action: "account.pause",
        actorEmail: "system:content-review",
        actorUserId: "system",
        reason,
        contentReviewId: review.id,
      },
    });
    void logger.reportError(
      "new account auto-paused: pre-send review blocked phishing content",
      new Error(review.summary),
      { accountId: account.id, accountName: account.name, contentReviewId: review.id },
    );
    return true;
  } catch (err) {
    console.error("[content-review] auto-pause failed for " + account.id + ":", err);
    return false;
  }
}

/** Reads the cached verdict for this content, or null if it has not been reviewed. */
export async function findContentReview(
  db: Db,
  accountId: string,
  fingerprint: string,
): Promise<ContentReview | null> {
  const row = await db.query.contentReviews.findFirst({
    where: and(
      eq(contentReviews.accountId, accountId),
      eq(contentReviews.fingerprint, fingerprint),
    ),
  });
  return row ?? null;
}

/**
 * Records that a stored verdict refused one more send. Best-effort and
 * deliberately un-awaited-safe: the refusal itself has already happened, and
 * losing a counter increment must never turn into a 500 that tells an attacker
 * their payload got further than it did.
 */
export async function countRefusal(db: Db, reviewId: string): Promise<void> {
  try {
    await db
      .update(contentReviews)
      .set({
        blockedCount: sql`${contentReviews.blockedCount} + 1`,
        updatedAt: nowIso(),
      })
      .where(eq(contentReviews.id, reviewId));
  } catch (err) {
    console.error(`[content-review] refusal counter failed for ${reviewId}:`, err);
  }
}

/**
 * The deterministic floor, run inline on the API request. Pure CPU, no I/O.
 *
 * This is what stops an abuse run at request #1 rather than at the worker, and
 * it is the only part of the review a Redis or model outage cannot take away.
 */
export function screenTransactionalContent(content: TransactionalContent): CampaignRiskReview {
  return runDeterministicRiskChecks(toRiskInput(content));
}

/**
 * Full review (deterministic + AI) for one fingerprint, persisted for reuse.
 *
 * Idempotent by construction: the insert is `onConflictDoNothing` against the
 * (account, fingerprint) unique index, so two workers racing on the first two
 * messages of a new shape both review, both try to store, one wins, and the
 * loser re-reads the winner's row. Reviewing twice costs one extra model call;
 * storing twice would corrupt the cache, and the index makes that impossible.
 */
export async function reviewAndStoreContent(
  db: Db,
  accountId: string,
  content: TransactionalContent,
  aiReviewMode: string | undefined,
): Promise<ContentReview> {
  const fingerprint = contentFingerprint(content);

  const existing = await findContentReview(db, accountId, fingerprint);
  if (existing) return existing;

  const review = await reviewCampaignRisk(toRiskInput(content), aiReviewMode);
  const now = nowIso();

  await db
    .insert(contentReviews)
    .values({
      id: newId("cvw"),
      accountId,
      fingerprint,
      riskLevel: review.riskLevel,
      riskScore: review.riskScore,
      categoriesJson: JSON.stringify(review.categories),
      summary: review.summary,
      guidanceJson: review.guidance.length > 0 ? JSON.stringify(review.guidance) : null,
      rawResponseJson: review.ai
        ? JSON.stringify(review.ai)
        : review.aiError
          ? JSON.stringify({ aiError: review.aiError })
          : null,
      subject: content.subject,
      fromEmail: content.fromEmail,
      fromName: content.fromName ?? null,
      blockedCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  // Re-read rather than trusting the insert: on conflict the winner's row is
  // the one every later send must agree with.
  const stored = await findContentReview(db, accountId, fingerprint);
  if (stored) {
    if (stored.riskLevel === "blocked") {
      const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
      if (account) await enforceBlockedVerdict(db, account, stored);
    }
    return stored;
  }

  // Unreachable in practice (we just inserted or conflicted). Falling back to a
  // synthesised row keeps the caller's contract total rather than throwing on
  // the send path.
  return {
    id: newId("cvw"),
    accountId,
    fingerprint,
    riskLevel: review.riskLevel,
    riskScore: review.riskScore,
    categoriesJson: JSON.stringify(review.categories),
    summary: review.summary,
    guidanceJson: null,
    rawResponseJson: null,
    subject: content.subject,
    fromEmail: content.fromEmail,
    fromName: content.fromName ?? null,
    blockedCount: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/** The message shown to an API caller whose content was refused. */
export function blockedMessage(review: Pick<ContentReview, "summary" | "riskLevel">): string {
  if (review.riskLevel === "high") {
    return (
      "This email was held by Day3's automated safety review and was not sent. New workspaces " +
      "cannot send high-risk content during their first two weeks. " +
      review.summary
    );
  }
  return (
    "This email was blocked by Day3's automated safety review and was not sent. " +
    review.summary
  );
}
