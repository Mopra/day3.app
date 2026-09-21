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
import { contentReviews, type ContentReview } from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { htmlToText } from "./risk-ai";
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

/** A stored verdict that refuses the send. */
export function isBlocking(review: Pick<ContentReview, "riskLevel">): boolean {
  return review.riskLevel === "blocked";
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
  if (stored) return stored;

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
export function blockedMessage(review: Pick<ContentReview, "summary">): string {
  return (
    "This email was blocked by Day3's automated safety review and was not sent. " +
    review.summary
  );
}
