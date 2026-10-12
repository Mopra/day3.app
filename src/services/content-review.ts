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
//
// SAMPLING. On an account that has earned review trust (services/review-trust.ts)
// the AI pass runs on one new shape in TRUSTED_SAMPLE_EVERY; the rest are stored
// deterministic-only with ai_review = 'sampled_out'. That is safe because an
// established sender's AI verdict can never refuse its transactional mail
// anyway (isBlocking), so the skipped call bought monitoring, not protection.
// A sampled-out row is not a permanent pass: once the account drops out of
// `trusted`, the next send of that shape is reviewed by the AI and the row is
// rewritten in place. The deterministic floor runs on every shape regardless.
import { and, eq, sql } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "../db/client";
import { accounts, contentReviews, type Account, type ContentReview } from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { logJob } from "../lib/job-log";
import { logger } from "../lib/logger";
import { htmlToText, type AiRiskVerdict } from "./risk-ai";
import { getReviewTrust, invalidateReviewTrust, shouldRunAiReview } from "./review-trust";
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
// digits, hex/base64-ish blobs, email addresses, URL query strings, and the
// single name token after a greeting. The words, the host names, and the
// structure all survive into the hash.
function normaliseForFingerprint(text: string): string {
  return text
    .toLowerCase()
    // URL query strings and fragments: per-recipient tracking, never content.
    .replace(/([?#])[^\s"'<>]*/g, "$1")
    // Email addresses.
    .replace(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/g, "@")
    // The one word after a greeting: "Hi Alice," and "Hi Bob," are one shape.
    // Without this every name-personalised reset or receipt was a new
    // fingerprint and paid a model call per recipient. Exactly one token, so
    // nothing with risk meaning can be hidden in the erased position.
    .replace(/\b(hi|hello|hey|dear|welcome)\s+[^\s,.!:;<]{1,40}/g, "$1 ~")
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

/** True when the verdict's own categories say a phishing pair rule fired. */
export function isHardBlock(review: { categories: string[] }): boolean {
  return review.categories.includes("phishing_pair");
}

/**
 * Does this verdict refuse the send?
 *
 * DAY3 IS A TRANSACTIONAL EMAIL SERVICE AS WELL AS A NEWSLETTER TOOL, and a
 * wrongly dropped transactional email is not a deliverability blemish, it is
 * a customer's password reset or outage alert that never arrived. So what may
 * refuse mail depends on whether the sender has earned trust:
 *
 *   - A phishing PAIR (`hardBlock`) refuses everyone. The pairs are specific
 *     enough to stand behind: impersonating another brand while asking for
 *     credentials, or asking for credentials behind a throwaway page host.
 *   - Inside the new-account ramp, a `blocked` verdict of any origin (keyword
 *     or AI) refuses too. That is where abuse actually lives: all three
 *     accounts in the September 2026 phishing run were hours old.
 *   - An ESTABLISHED sender is never refused by a keyword or by the model. It
 *     was, for a day: the AI pass read Exit1.dev's SSL-expiry alerts (which
 *     name the customer's website) as Exit1.dev impersonating itself and
 *     dropped them, and a keyword list dropped an alert because a monitored
 *     site was called "Bitcoingo". Those verdicts still land in the admin
 *     queue; they just do not stop the mail. Reputation (health.ts: bounces,
 *     complaints, spam rejections) is what polices an established sender,
 *     because it measures what recipients did rather than guessing at content.
 *
 * `high` refuses nobody. It used to refuse new accounts; the credential +
 * throwaway-host pair now catches the variant that rule existed for.
 */
export function isBlocking(
  review: { riskLevel: string; hardBlock?: boolean | null },
  account?: Pick<Account, "createdAt" | "rampLiftedAt"> | null,
): boolean {
  if (review.hardBlock) return true;
  if (review.riskLevel !== "blocked") return false;
  // No account in hand: fail closed on a blocked verdict (no caller does this).
  if (!account) return true;
  return isUnderRamp(account);
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
  review: Pick<ContentReview, "id" | "riskLevel" | "summary" | "subject" | "hardBlock">,
): Promise<boolean> {
  // Only a phishing pair may pause an account. A model or keyword verdict can
  // refuse a new account's message, but it is a guess, and pausing a brand new
  // customer's whole workspace on a guess (a monitoring service's first alert,
  // say) is not a mistake we get to make twice.
  if (!review.hardBlock) return false;
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

/** What the AI pass did for a stored row. Mirrors content_reviews.ai_review. */
export type AiReviewState = "reviewed" | "failed" | "sampled_out" | "off";

/** Test seams for reviewAndStoreContent. Production passes none of these. */
export type ReviewContentDeps = {
  /** Replaces the model call (risk-ai's aiReviewCampaign). */
  aiFn?: (input: RiskCheckInput) => Promise<AiRiskVerdict>;
  /** Replaces the sampling coin (review-trust's crypto-based default). */
  random?: () => number;
};

function aiReviewState(review: CampaignRiskReview, aiReviewMode: string | undefined): AiReviewState {
  if (aiReviewMode !== "ai") return "off";
  if (review.ai) return "reviewed";
  if (review.aiError) return "failed";
  // Mode was "ai" but the engine returned neither: treat as not looked at.
  return "off";
}

function rawResponse(review: CampaignRiskReview): string | null {
  if (review.ai) return JSON.stringify(review.ai);
  if (review.aiError) return JSON.stringify({ aiError: review.aiError });
  return null;
}

function isFlagged(row: Pick<ContentReview, "riskLevel" | "hardBlock">): boolean {
  return row.hardBlock || row.riskLevel === "high" || row.riskLevel === "blocked";
}

/**
 * Full review (deterministic + AI) for one fingerprint, persisted for reuse.
 *
 * Idempotent by construction: the insert is `onConflictDoNothing` against the
 * (account, fingerprint) unique index, so two workers racing on the first two
 * messages of a new shape both review, both try to store, one wins, and the
 * loser re-reads the winner's row. Reviewing twice costs one extra model call;
 * storing twice would corrupt the cache, and the index makes that impossible.
 *
 * Takes the whole account, not just its id: review trust needs its ramp and
 * risk status, and the hard-block pause needs it too. Every query below is
 * still scoped by `account.id`.
 */
export async function reviewAndStoreContent(
  db: Db,
  account: Account,
  content: TransactionalContent,
  aiReviewMode: string | undefined,
  deps: ReviewContentDeps = {},
): Promise<ContentReview> {
  const accountId = account.id;
  const fingerprint = contentFingerprint(content);
  const input = toRiskInput(content);

  const existing = await findContentReview(db, accountId, fingerprint);
  if (existing) {
    // A shape stored while the account was trusted skipped the model. If the
    // account has since lost that trust (a flag, a reputation warning, a
    // pause), this send is the moment to pay for the review it skipped:
    // otherwise a leaked key on a once-trusted account could keep sending a
    // shape nobody but the keyword list ever read.
    if (existing.aiReview !== "sampled_out" || aiReviewMode !== "ai") return existing;
    const trust = await getReviewTrust(db, account);
    if (trust.tier === "trusted") return existing;

    const review = await reviewCampaignRisk(input, aiReviewMode, deps.aiFn);
    // Guarded on ai_review = 'sampled_out' so two workers racing on the same
    // shape write once; the loser's model call is the only waste. blocked_count
    // and created_at are deliberately left alone: the refusal history and the
    // first-seen date belong to the shape, not to this verdict.
    await db
      .update(contentReviews)
      .set({
        riskLevel: review.riskLevel,
        riskScore: review.riskScore,
        categoriesJson: JSON.stringify(review.categories),
        summary: review.summary,
        guidanceJson: review.guidance.length > 0 ? JSON.stringify(review.guidance) : null,
        rawResponseJson: rawResponse(review),
        hardBlock: isHardBlock(review),
        aiReview: aiReviewState(review, aiReviewMode),
        trustTier: trust.tier,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(contentReviews.id, existing.id),
          eq(contentReviews.accountId, accountId),
          eq(contentReviews.aiReview, "sampled_out"),
        ),
      );
    const reread = (await findContentReview(db, accountId, fingerprint)) ?? existing;
    await afterStore(db, account, reread, aiReviewMode);
    return reread;
  }

  // Trust only matters when there is a model call to skip. Outside "ai" mode
  // (the API route's refusal path, mock-mode workers) it is not computed at
  // all: that keeps computeAccountHealth off the web tier's request path.
  const trust = aiReviewMode === "ai" ? await getReviewTrust(db, account) : null;
  // Sampled out: the deterministic floor still runs (it is what refuses a
  // phishing pair, on every tier); only the model call is skipped.
  const sampledOut = trust !== null && !shouldRunAiReview(trust, deps.random);
  const review = sampledOut
    ? await reviewCampaignRisk(input, undefined)
    : await reviewCampaignRisk(input, aiReviewMode, deps.aiFn);
  const aiReview: AiReviewState = sampledOut ? "sampled_out" : aiReviewState(review, aiReviewMode);
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
      rawResponseJson: rawResponse(review),
      subject: content.subject,
      fromEmail: content.fromEmail,
      fromName: content.fromName ?? null,
      // The AI's categories are a closed enum without `phishing_pair`, so this
      // is true only when the deterministic floor itself fired a pair.
      hardBlock: isHardBlock(review),
      blockedCount: 0,
      aiReview,
      trustTier: trust?.tier ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  // Re-read rather than trusting the insert: on conflict the winner's row is
  // the one every later send must agree with.
  const stored = await findContentReview(db, accountId, fingerprint);
  if (stored) {
    await afterStore(db, account, stored, aiReviewMode);
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
    hardBlock: isHardBlock(review),
    blockedCount: 0,
    aiReview,
    trustTier: trust?.tier ?? null,
    createdAt: now,
    updatedAt: now,
  };
}

// What follows every stored or rewritten verdict. A flagged verdict drops this
// process's cached trust so the account is re-evaluated on its next new shape
// rather than after the cache TTL (other processes see it when their own cache
// expires), and a phishing pair may pause a new account. Trust is only cached
// in "ai" mode, so there is nothing to invalidate outside it.
async function afterStore(
  db: Db,
  account: Account,
  row: ContentReview,
  aiReviewMode: string | undefined,
): Promise<void> {
  if (aiReviewMode === "ai" && isFlagged(row)) invalidateReviewTrust(account.id);
  if (row.hardBlock) await enforceBlockedVerdict(db, account, row);
}

/** The message shown to an API caller whose content was refused. */
export function blockedMessage(review: Pick<ContentReview, "summary" | "riskLevel">): string {
  return (
    "This email was blocked by Day3's automated safety review and was not sent. " +
    review.summary
  );
}
