// Extra holds for campaigns from NEW accounts (inside the send ramp).
//
// The review handler already holds anything whose recommended action is
// `block` (riskLevel `high`). That missed Service spt on 2026-10-19: the AI said
// its campaign "reads like a lure that could be used to impersonate another
// service", rated it below `high`, and 15 campaigns of about 33 went out to
// scraped Gmail and iCloud addresses, 496 emails on day one. The email itself
// asked for nothing (the phishing happened on the linked page), so no
// deterministic pair could fire. The AI had the right words; nothing acted on
// them.
//
// So for a new account two more things hold the campaign for an admin:
//   1. the review names a lure: an AI phishing / impersonation / credential
//      category, or a rationale that says so in words;
//   2. the review is at least `medium` AND the recipients are mostly consumer
//      mailboxes (gmail, icloud, ...). A B2B SaaS newsletter mails work
//      addresses; a brand-new workspace mailing hundreds of freemail strangers
//      with already-flagged content is what a scraped list looks like.
//
// Neither alone is evidence for an established sender, and a consumer-heavy
// list alone is not evidence for anyone (B2C products exist), which is why the
// second rule needs a flagged review too. It is a hold, not a block: an admin
// releases an honest one from the review queue in one click.
import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { subscribers, type Account } from "../db/schema";
import type { CampaignRiskReview } from "./risk";
import { rampDailyLimit } from "./send-ramp";

// AI categories that mean "this could be a lure". Only the AI's categories, not
// the deterministic ones: each deterministic signal alone has an innocent
// reading (AGENTS.md rule 6), and the pairs that don't already block.
const LURE_CATEGORIES = new Set(["phishing_like", "brand_impersonation", "credential_harvest"]);
const LURE_WORDS = /\b(lure|phishing|impersonat\w*|credential[- ]harvest\w*)\b/i;

// The big consumer mailbox providers. Deliberately the large ones only: a
// list of every ISP would mark honest regional audiences, and the scraped
// lists we have seen are overwhelmingly these.
export const CONSUMER_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "yahoo.com",
  "ymail.com",
  "hotmail.com",
  "outlook.com",
  "live.com",
  "msn.com",
  "aol.com",
  "gmx.com",
  "gmx.de",
  "web.de",
  "mail.ru",
  "yandex.ru",
  "proton.me",
  "protonmail.com",
];

/** Share of recipients on consumer mailboxes at which the audience counts as consumer-heavy. */
export const CONSUMER_SHARE_THRESHOLD = 0.8;
/** Below this many recipients the share says nothing (a founder mailing five friends). */
export const CONSUMER_MIN_RECIPIENTS = 20;

/** New = still inside the send ramp. Same test the transactional path uses. */
export function isNewAccount(account: Pick<Account, "createdAt" | "rampLiftedAt">, now = new Date()): boolean {
  return rampDailyLimit(account, now) !== null;
}

// A rationale often says what it did NOT find ("no phishing indicators"), so a
// sentence carrying a negation never counts.
const NEGATION = /\b(no|not|nor|without|none|never|doesn't|does not|isn't|lacks?)\b/i;

/**
 * The AI named a lure, by category or in its own words. The words count only
 * when the AI itself rated the campaign above `low`: spt's verdict put "reads
 * like a lure" in the rationale, not necessarily in a category.
 */
export function aiNamesLure(review: Pick<CampaignRiskReview, "ai">): boolean {
  const ai = review.ai;
  if (!ai) return false;
  if (ai.categories.some((c) => LURE_CATEGORIES.has(c))) return true;
  if (ai.riskLevel === "low") return false;
  return ai.rationale
    .split(/(?<=[.!?])\s+/)
    .some((sentence) => LURE_WORDS.test(sentence) && !NEGATION.test(sentence));
}

export type AudienceMix = { total: number; consumer: number };

/** Recipients in scope and how many are on consumer mailboxes. */
export async function audienceMix(
  db: Db,
  campaign: { accountId: string; audienceId: string },
  scopeConditions: SQL[],
): Promise<AudienceMix> {
  const domains = sql.join(
    CONSUMER_DOMAINS.map((d) => sql`${d}`),
    sql`, `,
  );
  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      consumer: sql<number>`count(*) filter (where lower(split_part(${subscribers.email}, '@', 2)) in (${domains}))::int`,
    })
    .from(subscribers)
    .where(
      and(
        eq(subscribers.accountId, campaign.accountId),
        eq(subscribers.audienceId, campaign.audienceId),
        eq(subscribers.status, "subscribed"),
        ...scopeConditions,
      ),
    );
  return { total: row?.total ?? 0, consumer: row?.consumer ?? 0 };
}

export function isConsumerHeavy(mix: AudienceMix): boolean {
  return mix.total >= CONSUMER_MIN_RECIPIENTS && mix.consumer / mix.total >= CONSUMER_SHARE_THRESHOLD;
}

/**
 * Why a new account's campaign is held, or null to let it through. Only called
 * for reviews that would otherwise approve.
 */
export function newAccountHoldReason(
  review: Pick<CampaignRiskReview, "ai" | "riskLevel">,
  mix: AudienceMix | null,
): string | null {
  if (aiNamesLure(review)) {
    return "Our pre-send review thinks this campaign could read as a lure or an impersonation of another service, and this workspace is new, so it is held for a manual check before anything goes out.";
  }
  if (review.riskLevel === "medium" && mix && isConsumerHeavy(mix)) {
    const pct = Math.round((mix.consumer / mix.total) * 100);
    return `Our pre-send review flagged this campaign, and ${pct}% of the ${mix.total.toLocaleString("en-US")} contacts it targets are personal mailboxes (Gmail, iCloud and similar). For a new workspace that is the pattern of a bought or scraped list, so it is held for a manual check before anything goes out.`;
  }
  return null;
}
