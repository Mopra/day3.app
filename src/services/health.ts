import { and, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  accounts,
  campaignRecipients,
  campaigns,
  emailEvents,
  transactionalEmails,
  type Campaign,
} from "../db/schema";
import { nowIso } from "../lib/ids";
import { logger } from "../lib/logger";

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------
//
// The bars mirror what Amazon SES applies to the platform's one shared sending
// account. SES opens a review at 5% bounces / 0.1% complaints and stops a
// sender at 10% / 0.5%. Day3 warns where SES reviews and pauses an account
// short of where SES would stop us, because one tenant's rate becomes every
// tenant's problem once it moves the account-wide number.
//
// These used to be stricter than SES's own review line (4% / 0.08%), which
// meant we were locking out paying customers before AWS would have so much as
// emailed us. A first send from an honestly-collected but ageing list bounces at
// 5-6%: dead mailboxes are how lists age. That is a list to clean, not a
// spammer to stop, and 4 of the first 13 paying accounts hit the old bar.
export const BOUNCE_RATE_WARNING = 0.05;
export const BOUNCE_RATE_PAUSE = 0.08;
export const COMPLAINT_RATE_WARNING = 0.001;
export const COMPLAINT_RATE_PAUSE = 0.003;

// Below this many attempted sends, rates are too noisy to say anything at all.
export const MIN_ATTEMPTED_FOR_ENFORCEMENT = 50;

// A rate on its own is not evidence. At the 50-attempted floor, 5% is three
// bounces and 0.1% rounds to one "report spam" click, so every tier needs an
// absolute count of bad addresses behind its rate before it means anything.
//
// The warning tier emails the account's admins, so it needs a floor too: the
// old warning fired on two bounces, which was fine for an amber light and is
// not fine for an inbox.
export const MIN_BOUNCED_FOR_WARNING = 20;
export const MIN_COMPLAINED_FOR_WARNING = 2;

// The account pause is one-way (`risk_status` flips and only an operator
// resumes), so its floor sits well above the noise: the smallest possible
// pause is 50 hard bounces (>= 625 attempted) or 5 complaints (>= 1667
// attempted). An account genuinely mailing a purchased list blows through both
// on its first real send; an account with a stale-but-honest list gets the
// campaign-level pause below and a warning, and never touches these.
export const MIN_BOUNCED_FOR_PAUSE = 50;
export const MIN_COMPLAINED_FOR_PAUSE = 5;

// Escalation. One campaign paused for its own bounce rate is a heads-up; a
// second one inside the window, while the account is still over the warning
// line, is a pattern (the tenant keeps importing lists that bounce), and the
// account pauses at the warning rate instead of waiting for the pause rate.
export const MIN_FLAGGED_CAMPAIGNS_FOR_PAUSE = 2;

// Campaign-level pause (enforceCampaignHealth). This is the middle step that
// used to be missing: the first response to a bad list is to stop THAT send,
// tell the customer what bounced and let them resume, not to lock the account.
// It fires at the warning rate, once per campaign (the flag survives resume),
// and only after enough of the campaign is out to judge it: 200 attempted, or a
// quarter of the recipients for a campaign smaller than 800. Hard bounces from
// Gmail/Outlook/iCloud arrive within seconds, so without that floor the first
// few hundred emails would decide the whole send.
export const CAMPAIGN_MIN_ATTEMPTED_FOR_PAUSE = 200;
export const CAMPAIGN_MIN_ATTEMPTED_SHARE = 0.25;
export const CAMPAIGN_MIN_BOUNCED_FOR_PAUSE = 20;
export const CAMPAIGN_MIN_COMPLAINED_FOR_PAUSE = 3;

// Reputation is judged over a TRAILING WINDOW of recent sends, not the account's
// lifetime. SES suspends on *recent* bounce/complaint rates, so a long good
// history must not dilute a current spike — an account that sent cleanly for
// months can still cross SES's thresholds today, and a lifetime average would
// react far too slowly. Env-tunable; defaults to 14 days.
export const HEALTH_WINDOW_DAYS = Math.max(1, Number(process.env.HEALTH_WINDOW_DAYS ?? "14"));

// Which producer put the mail on the wire. Reputation is judged account-wide —
// AWS sees one sender — but an account whose numbers are sliding needs to know
// WHICH stream is doing it, because the fix differs completely: a bad campaign
// audience is cleaned, a bad API integration is fixed in the customer's code.
export const HEALTH_SOURCES = ["campaign", "automation", "api"] as const;
export type HealthSource = (typeof HEALTH_SOURCES)[number];

export type HealthSourceCounts = {
  source: HealthSource;
  attempted: number;
  bounced: number;
  complained: number;
};

export type AccountHealth = {
  attempted: number;
  bounced: number;
  complained: number;
  bounceRate: number;
  complaintRate: number;
  // Campaigns in the window that enforceCampaignHealth paused for their own
  // rate. Feeds the escalation rule; shown on the Metrics page.
  flaggedCampaigns: number;
  status: "normal" | "warning" | "paused";
  reason?: string;
  // The same window, split by producer. Sums exactly to the totals above — it is
  // built from the same three queries, not a second pass, so the Metrics page
  // can show the split without any risk of it disagreeing with the headline.
  bySource: HealthSourceCounts[];
};

const COUNTED_TX_STATUSES = ["sent", "delivered", "bounced", "complained"] as const;

// Statuses that mean "we handed this to the provider": the denominator of every
// rate here. `unsubscribed` reached a mailbox too — it counts in the
// denominator and nowhere else.
const ATTEMPTED_STATUSES = ["sent", "delivered", "bounced", "complained", "unsubscribed"] as const;

// The two ledgers share `campaign_recipients`, so which producer wrote a row is
// a predicate rather than a column (see AGENTS.md — the table name is a
// misnomer). `campaign_id` is the discriminator the Activity page uses too.
const RECIPIENT_SOURCE_SQL = sql<HealthSource>`case when ${campaignRecipients.campaignId} is not null then 'campaign' else 'automation' end`;

// One row per (message, address, event type) is what the email_events unique
// index guarantees, so this counts ADDRESSES that went wrong rather than
// messages. Exported because the Metrics page's transactional card has to count
// its bounces the same way this does, or the two cards on one screen disagree.
export const TX_BAD_ADDRESS_COUNT_SQL = sql<number>`count(distinct (${emailEvents.transactionalEmailId} || ':' || coalesce(${emailEvents.email}, '')))`;

// Bounce events are recorded for soft bounces too (the SES webhook records
// first and gates only the status flip on Permanent/Undetermined), so the
// bounce type is filtered to match campaign semantics. `payload_json` is the raw
// SNS notification held as text; a `::jsonb` cast would throw on any row that is
// not parseable, so this matches the field textually instead — `bounceType`
// appears exactly once in a bounce notification. The POSIX character class
// avoids a backslash escape surviving the template literal.
export const HARD_BOUNCE_ONLY_SQL = sql`(${emailEvents.eventType} <> 'bounce' OR ${emailEvents.payloadJson} ~ '"bounceType"[[:space:]]*:[[:space:]]*"(Permanent|Undetermined)"')`;

export const pct = (rate: number, digits = 2): string => `${(rate * 100).toFixed(digits)}%`;

export async function computeAccountHealth(db: Db, accountId: string): Promise<AccountHealth> {
  // Only count emails SENT within the trailing window. `sent_at` is set on the
  // send and preserved through later delivered/bounced/complained transitions,
  // so this captures "of what we sent recently, how much went wrong" — the rate
  // SES actually reacts to. (ISO timestamps compare correctly against a tstz col.)
  const cutoff = new Date(Date.now() - HEALTH_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();
  const rows = await db
    .select({
      source: RECIPIENT_SOURCE_SQL,
      status: campaignRecipients.status,
      count: sql<number>`count(*)`.as("count"),
    })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.accountId, accountId),
        gte(campaignRecipients.sentAt, cutoff),
        inArray(campaignRecipients.status, [...ATTEMPTED_STATUSES]),
      ),
    )
    // Grouping by the producer as well as the status costs nothing here (same
    // index scan, one more grouping key) and is what lets this stay ONE query
    // on the send path while still feeding the Metrics page its breakdown.
    .groupBy(RECIPIENT_SOURCE_SQL, campaignRecipients.status);

  // Transactional (API) sends count toward the SAME reputation. They must:
  // AWS judges one bounce rate for the whole SES account, and the API is the
  // path that skips campaign review entirely — an account mailing a harvested
  // list through POST /v1/emails would otherwise never trip the auto-pause.
  //
  // A message carries up to 50 recipients, so the denominator weighs
  // jsonb_array_length(to) rather than one row per message.
  const [txAttemptedRow] = await db
    .select({
      count: sql<number>`coalesce(sum(jsonb_array_length(${transactionalEmails.to})), 0)`.as(
        "count",
      ),
    })
    .from(transactionalEmails)
    .where(
      and(
        eq(transactionalEmails.accountId, accountId),
        gte(transactionalEmails.sentAt, cutoff),
        inArray(transactionalEmails.status, [...COUNTED_TX_STATUSES]),
      ),
    );

  // The NUMERATOR has to be counted per ADDRESS, not per message. A bounce or
  // complaint for any one recipient flips the whole message's status, so
  // grouping the recipient count by message status charged all 50 addresses of a
  // 50-recipient message for one dead mailbox — one such message read as a 100%
  // bounce rate on its own and paused the account. `email_events` already holds
  // exactly one row per (message, address, event type) — that is what its unique
  // index is for — so it is the honest source for "how many addresses actually
  // went wrong", and it makes transactional weigh the same as the per-recipient
  // campaign ledger.
  const txEventRows = await db
    .select({
      eventType: emailEvents.eventType,
      count: TX_BAD_ADDRESS_COUNT_SQL.as("count"),
    })
    .from(emailEvents)
    .innerJoin(transactionalEmails, eq(emailEvents.transactionalEmailId, transactionalEmails.id))
    .where(
      and(
        eq(emailEvents.accountId, accountId),
        gte(transactionalEmails.sentAt, cutoff),
        inArray(transactionalEmails.status, [...COUNTED_TX_STATUSES]),
        inArray(emailEvents.eventType, ["bounce", "complaint"]),
        HARD_BOUNCE_ONLY_SQL,
      ),
    )
    .groupBy(emailEvents.eventType);

  // Campaigns the campaign-level rule already paused inside the window. Soft-
  // deleted campaigns still count: deleting the campaign is not a way to
  // un-happen the send.
  const [flaggedRow] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.accountId, accountId),
        isNotNull(campaigns.reputationFlaggedAt),
        gte(campaigns.reputationFlaggedAt, cutoff),
      ),
    );
  const flaggedCampaigns = Number(flaggedRow?.count ?? 0);

  // Fold the three reads into one row per producer FIRST, then sum. Deriving the
  // totals from the split (rather than computing them separately) is what makes
  // the Metrics page's breakdown provably add up to the number that pauses the
  // account.
  const perSource = new Map<HealthSource, HealthSourceCounts>(
    HEALTH_SOURCES.map((source) => [source, { source, attempted: 0, bounced: 0, complained: 0 }]),
  );
  for (const r of rows) {
    const entry = perSource.get(r.source as HealthSource);
    if (!entry) continue;
    const n = Number(r.count);
    entry.attempted += n;
    if (r.status === "bounced") entry.bounced += n;
    if (r.status === "complained") entry.complained += n;
  }
  const api = perSource.get("api")!;
  api.attempted = Number(txAttemptedRow?.count ?? 0);
  for (const r of txEventRows) {
    if (r.eventType === "bounce") api.bounced = Number(r.count);
    if (r.eventType === "complaint") api.complained = Number(r.count);
  }

  const bySource = [...perSource.values()];
  const bounced = bySource.reduce((n, s) => n + s.bounced, 0);
  const complained = bySource.reduce((n, s) => n + s.complained, 0);
  const attempted = bySource.reduce((n, s) => n + s.attempted, 0);

  const bounceRate = attempted > 0 ? bounced / attempted : 0;
  const complaintRate = attempted > 0 ? complained / attempted : 0;

  let status: AccountHealth["status"] = "normal";
  let reason: string | undefined;

  if (attempted >= MIN_ATTEMPTED_FOR_ENFORCEMENT) {
    // Both halves, always: the rate says the proportion is bad, the count says
    // there is enough of it to believe the rate.
    const bounceWarning = bounceRate >= BOUNCE_RATE_WARNING && bounced >= MIN_BOUNCED_FOR_WARNING;
    const complaintWarning =
      complaintRate >= COMPLAINT_RATE_WARNING && complained >= MIN_COMPLAINED_FOR_WARNING;
    const days = `${HEALTH_WINDOW_DAYS} days`;

    if (bounceRate >= BOUNCE_RATE_PAUSE && bounced >= MIN_BOUNCED_FOR_PAUSE) {
      status = "paused";
      reason = `Bounce rate ${pct(bounceRate)} exceeded ${pct(BOUNCE_RATE_PAUSE, 0)} (${bounced} bounced of ${attempted} sent in ${days})`;
    } else if (complaintRate >= COMPLAINT_RATE_PAUSE && complained >= MIN_COMPLAINED_FOR_PAUSE) {
      status = "paused";
      reason = `Complaint rate ${pct(complaintRate, 3)} exceeded ${pct(COMPLAINT_RATE_PAUSE, 1)} (${complained} complaints of ${attempted} sent in ${days})`;
    } else if (
      flaggedCampaigns >= MIN_FLAGGED_CAMPAIGNS_FOR_PAUSE &&
      (bounceWarning || complaintWarning)
    ) {
      status = "paused";
      reason = bounceWarning
        ? `${flaggedCampaigns} campaigns were paused for bouncing in ${days} and the bounce rate is still ${pct(bounceRate)} (${bounced} bounced of ${attempted} sent)`
        : `${flaggedCampaigns} campaigns were paused for spam complaints in ${days} and the complaint rate is still ${pct(complaintRate, 3)} (${complained} complaints of ${attempted} sent)`;
    } else if (bounceWarning || complaintWarning) {
      // Warn early, pause late.
      status = "warning";
    }
  }

  return {
    attempted,
    bounced,
    complained,
    bounceRate,
    complaintRate,
    flaggedCampaigns,
    status,
    reason,
    bySource,
  };
}

// Pauses the account if its health thresholds are exceeded, and tells the
// account's admins when it warns or pauses. Returns the health.
export async function enforceAccountHealth(db: Db, accountId: string): Promise<AccountHealth> {
  const health = await computeAccountHealth(db, accountId);

  if (health.status === "warning") {
    // Sending continues; the admins hear about it once a week at most, and not
    // at all in the day after a campaign-level pause already told them the
    // same thing with more detail. Best-effort, never on the caller's path.
    try {
      const { notifyAccountThrottled, hasRecentNotification } = await import("./notifications");
      const account = await db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
      if (
        account &&
        account.riskStatus === "normal" &&
        !(await hasRecentNotification(db, accountId, "campaign_reputation_paused", 24))
      ) {
        await notifyAccountThrottled(db, account, accountWarningNotification(health), 24 * 7);
      }
    } catch (err) {
      console.error("[health] account-warning notification failed", err);
    }
    return health;
  }

  if (health.status === "paused") {
    // The `riskStatus = 'normal'` guard means RETURNING is non-empty only on the
    // actual normal→paused transition, not on the many later bounce/complaint
    // webhooks for an already-paused account — so we alert exactly once.
    const flipped = await db
      .update(accounts)
      .set({
        sendingEnabled: false,
        riskStatus: "paused",
        pausedReason: health.reason,
        updatedAt: nowIso(),
      })
      .where(and(eq(accounts.id, accountId), eq(accounts.riskStatus, "normal")))
      .returning({ id: accounts.id });

    if (flipped.length > 0) {
      // A reputation auto-pause is one of the highest-severity operational
      // events (it can precede an SES account-level suspension that affects every
      // tenant), so ship it to the error sink to page on-call — not just a log
      // line nobody reads. Best-effort; never block the webhook/send path.
      void logger.reportError(
        "account auto-paused for reputation (bounce/complaint rate)",
        new Error(health.reason ?? "reputation threshold exceeded"),
        {
          accountId,
          attempted: health.attempted,
          bounced: health.bounced,
          complained: health.complained,
          bounceRate: Number(health.bounceRate.toFixed(4)),
          complaintRate: Number(health.complaintRate.toFixed(5)),
          flaggedCampaigns: health.flaggedCampaigns,
          windowDays: HEALTH_WINDOW_DAYS,
        },
      );
      // Tell the tenant too — they're the only one who can fix their list, and
      // without this their in-flight campaign just stops with no explanation.
      // Best-effort and guarded by the exactly-once transition above. Imported
      // lazily to keep this module free of a static notifications dependency
      // (notifications imports the email factory).
      try {
        const { notifyAccount } = await import("./notifications");
        const account = await db.query.accounts.findFirst({
          where: eq(accounts.id, accountId),
        });
        if (account) await notifyAccount(db, account, accountPausedNotification(health));
      } catch (err) {
        console.error("[health] account-paused notification failed", err);
      }
    }
  }
  return health;
}

// ---------------------------------------------------------------------------
// Campaign-level pause
// ---------------------------------------------------------------------------

export type CampaignHealth = {
  total: number;
  attempted: number;
  bounced: number;
  complained: number;
  bounceRate: number;
  complaintRate: number;
  // False while too little of the campaign is out to say anything.
  judged: boolean;
  paused: boolean;
  reason?: string;
};

export function campaignMinAttempted(total: number): number {
  return Math.min(
    CAMPAIGN_MIN_ATTEMPTED_FOR_PAUSE,
    Math.max(1, Math.ceil(total * CAMPAIGN_MIN_ATTEMPTED_SHARE)),
  );
}

// Judges ONE in-flight campaign on its own numbers and pauses it if its
// bounce or complaint rate is at the warning line, once. Called from the SES
// webhook on every hard bounce / complaint for a campaign recipient. Returns
// null when there is nothing to judge (campaign gone, not sending, or already
// flagged), so the caller's hot path stays one cheap read in the common case.
export async function enforceCampaignHealth(
  db: Db,
  campaignId: string,
): Promise<CampaignHealth | null> {
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!campaign || campaign.status !== "sending" || campaign.reputationFlaggedAt) return null;

  const rows = await db
    .select({ status: campaignRecipients.status, count: sql<number>`count(*)`.as("count") })
    .from(campaignRecipients)
    .where(eq(campaignRecipients.campaignId, campaign.id))
    .groupBy(campaignRecipients.status);

  let total = 0;
  let attempted = 0;
  let bounced = 0;
  let complained = 0;
  for (const r of rows) {
    const n = Number(r.count);
    total += n;
    if ((ATTEMPTED_STATUSES as readonly string[]).includes(r.status)) attempted += n;
    if (r.status === "bounced") bounced += n;
    if (r.status === "complained") complained += n;
  }
  const bounceRate = attempted > 0 ? bounced / attempted : 0;
  const complaintRate = attempted > 0 ? complained / attempted : 0;
  const health: CampaignHealth = {
    total,
    attempted,
    bounced,
    complained,
    bounceRate,
    complaintRate,
    judged: attempted >= campaignMinAttempted(total),
    paused: false,
  };
  if (!health.judged) return health;

  let reason: string | undefined;
  if (bounceRate >= BOUNCE_RATE_WARNING && bounced >= CAMPAIGN_MIN_BOUNCED_FOR_PAUSE) {
    reason = `Bounce rate ${pct(bounceRate)} exceeded ${pct(BOUNCE_RATE_WARNING, 0)} (${bounced} bounced of ${attempted} sent so far)`;
  } else if (
    complaintRate >= COMPLAINT_RATE_WARNING &&
    complained >= CAMPAIGN_MIN_COMPLAINED_FOR_PAUSE
  ) {
    reason = `Complaint rate ${pct(complaintRate, 3)} exceeded ${pct(COMPLAINT_RATE_WARNING, 1)} (${complained} complaints of ${attempted} sent so far)`;
  }
  if (!reason) return health;

  // The status guard claims the sending→paused transition exactly once even
  // under concurrent webhooks; the flag is written in the same statement so a
  // resume can never re-arm this campaign.
  const now = nowIso();
  const claimed = await db
    .update(campaigns)
    .set({
      status: "paused",
      pausedCode: "reputation",
      pausedReason: reason,
      reputationFlaggedAt: now,
      updatedAt: now,
    })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "sending")))
    .returning({ id: campaigns.id });
  if (claimed.length === 0) return health;

  health.paused = true;
  health.reason = reason;
  logger.warn("campaign auto-paused for its own bounce/complaint rate", {
    campaignId: campaign.id,
    accountId: campaign.accountId,
    attempted,
    bounced,
    complained,
  });
  try {
    const { notifyAccount } = await import("./notifications");
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.id, campaign.accountId),
    });
    if (account) await notifyAccount(db, account, campaignPausedNotification(campaign, health));
  } catch (err) {
    console.error("[health] campaign-paused notification failed", err);
  }
  return health;
}

// ---------------------------------------------------------------------------
// What the admins are told, and why
// ---------------------------------------------------------------------------
//
// Every one of these says three things: what happened (the numbers), why it
// matters (what inbox providers and SES do with that number), and what to do
// next. A bare "bounce rate exceeded 5%" reads as an accusation; the customer
// whose two-year-old list just bounced needs to hear that dead mailboxes are
// normal, that the bad addresses are already gone, and how to get back to
// sending. Kept next to the rule so the text and the thresholds move together.

const WHY_BOUNCES =
  "A hard bounce means the mailbox no longer exists. Gmail, Outlook and the other inbox providers judge a sender by this number: above 5% they start filtering everything you send, not just the campaign that bounced.";
const WHY_COMPLAINTS =
  'A complaint is a recipient pressing "report spam". Inbox providers treat it as the strongest signal there is: above 0.1% they start filtering everything you send.';
const ALREADY_SUPPRESSED =
  "Every address that bounced or complained has already been removed from your audience and will never be mailed again.";
const HOW_TO_FIX =
  "To bring the number down: remove contacts who have not opened anything in a year, do not import lists you did not collect yourself, and turn on double opt-in for your signup forms.";

export function campaignPausedNotification(
  campaign: Pick<Campaign, "id" | "name">,
  health: CampaignHealth,
) {
  const overBounces =
    health.bounceRate >= BOUNCE_RATE_WARNING && health.bounced >= CAMPAIGN_MIN_BOUNCED_FOR_PAUSE;
  const byComplaints = !overBounces;
  const what = byComplaints
    ? `${health.complained} of the first ${health.attempted} recipients marked "${campaign.name}" as spam (${pct(health.complaintRate, 2)}).`
    : `${health.bounced} of the first ${health.attempted} emails from "${campaign.name}" hard-bounced (${pct(health.bounceRate)}).`;
  const why = byComplaints ? WHY_COMPLAINTS : WHY_BOUNCES;
  const next = byComplaints
    ? "Before you resume, look at who this went to and whether they asked for it: a complaint rate this high usually means the list was not collected by opt-in, or the content does not match what people signed up for."
    : "You can resume the send safely. Before you do, look at where this list came from: a rate this high usually means it is old or was not collected by opt-in, and the rest of it will bounce at about the same rate.";
  return {
    kind: "campaign_reputation_paused" as const,
    title: byComplaints
      ? `"${campaign.name}" is paused: too many spam complaints`
      : `"${campaign.name}" is paused: too many addresses are bouncing`,
    body: `${what} ${why} We paused the send so the rest of the list does not make it worse. ${ALREADY_SUPPRESSED} ${next}`,
    ctaHref: `/campaigns/${campaign.id}`,
    ctaLabel: "Review and resume",
  };
}

export function accountWarningNotification(health: AccountHealth) {
  const days = `${HEALTH_WINDOW_DAYS} days`;
  const parts: string[] = [];
  if (health.bounceRate >= BOUNCE_RATE_WARNING && health.bounced >= MIN_BOUNCED_FOR_WARNING) {
    parts.push(
      `${health.bounced} of the ${health.attempted} emails your workspace sent in the last ${days} hard-bounced (${pct(health.bounceRate)}).`,
    );
  }
  if (
    health.complaintRate >= COMPLAINT_RATE_WARNING &&
    health.complained >= MIN_COMPLAINED_FOR_WARNING
  ) {
    parts.push(
      `${health.complained} of the ${health.attempted} recipients you mailed in the last ${days} marked it as spam (${pct(health.complaintRate, 2)}).`,
    );
  }
  const why = `Amazon SES, which delivers Day3's mail, reviews senders above ${pct(BOUNCE_RATE_WARNING, 0)} bounces or ${pct(COMPLAINT_RATE_WARNING, 1)} complaints, so we pause a workspace that reaches ${pct(BOUNCE_RATE_PAUSE, 0)} bounces or ${pct(COMPLAINT_RATE_PAUSE, 1)} complaints.`;
  return {
    kind: "account_health_warning" as const,
    title: "Your sending reputation needs attention",
    body: `${parts.join(" ")} You are still sending. ${why} ${HOW_TO_FIX}`,
    ctaHref: "/metrics",
    ctaLabel: "See your reputation",
  };
}

export function accountPausedNotification(health: AccountHealth) {
  const what = health.reason ?? "Bounce or complaint rates exceeded the safe threshold";
  return {
    kind: "account_paused" as const,
    title: "Sending is paused for your workspace",
    body: `${what}. That is close to the line where Amazon SES, which delivers mail for every Day3 workspace, would restrict the whole platform, so we stopped sending for your workspace before it got there. Nothing you sent is lost, and every address that bounced or complained has already been removed from your audience. To get sending re-enabled, remove stale or purchased addresses from your audience, then reply to this email or contact support and we will lift the pause together. ${HOW_TO_FIX}`,
    ctaHref: "/audiences",
    ctaLabel: "Review your audience",
  };
}
