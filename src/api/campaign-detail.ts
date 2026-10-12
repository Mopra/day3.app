import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { riskReviews, type Account, type Campaign } from "../db/schema";
import { safeParseSections } from "../lib/sections";
import { safeParseTheme } from "../lib/theme";
import { accountSandboxMode } from "../services/sandbox";
import { rampRemaining } from "../services/send-ramp";
import {
  campaignPersonalizationGaps,
  campaignStats,
  sandboxRecipientCount,
} from "./campaigns";

// Everything the campaign page shows about one campaign. Two front doors read it:
// the server page (first paint) and `GET /api/campaigns/[id]` (the live poll and
// the re-read after an action), so they can't drift apart.
export async function readCampaignDetail(db: Db, account: Account, campaign: Campaign) {
  // Personalization gaps and the sandbox count only matter pre-send
  // (draft/approved); skip those queries once the campaign is in flight or done.
  const submittable = campaign.status === "draft" || campaign.status === "approved";
  const [review, stats, personalization, sandboxRecipients] = await Promise.all([
    db.query.riskReviews.findFirst({
      where: and(eq(riskReviews.campaignId, campaign.id), eq(riskReviews.accountId, account.id)),
    }),
    campaignStats(db, campaign.id),
    submittable ? campaignPersonalizationGaps(db, account.id, campaign) : [],
    // How many people this send would actually reach in sandbox mode, so the
    // confirmation dialog can name the real number. null = not a sandbox account
    // (or nothing left to confirm), and the audience count applies as usual.
    submittable && accountSandboxMode(account)
      ? sandboxRecipientCount(db, account.id, campaign)
      : null,
  ]);
  return {
    // Surface the structured sections + theme (parsed from the stored JSON) so the
    // composer can rehydrate the builder and styling panel; htmlBody remains the
    // canonical serialized body.
    campaign: {
      ...campaign,
      sections: safeParseSections(campaign.sectionsJson),
      theme: safeParseTheme(campaign.themeJson),
    },
    riskReview: review ?? null,
    stats,
    personalization,
    sandboxRecipients,
    // Emails the new-account ramp still allows today (null = no ramp). The send
    // dialog uses it to say "about N go out today, the rest tomorrow" before a
    // young account's first big send, instead of the campaign pausing on it.
    rampRemaining: submittable ? rampRemaining(account) : null,
  };
}

export type CampaignDetail = Awaited<ReturnType<typeof readCampaignDetail>>;
