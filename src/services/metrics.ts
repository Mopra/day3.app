import { and, eq, inArray, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import {
  automations,
  campaignRecipients,
  campaigns,
  emailEvents,
  transactionalEmails,
} from "../db/schema";
import type {
  AutomationMetricsRow,
  CampaignMetricCounts,
  CampaignMetricsRow,
  TransactionalMetricCounts,
  TransactionalMetrics,
  ReputationSummary,
  TransactionalSenderRow,
} from "../lib/types";
import {
  BOUNCE_RATE_PAUSE,
  BOUNCE_RATE_WARNING,
  COMPLAINT_RATE_PAUSE,
  COMPLAINT_RATE_WARNING,
  HARD_BOUNCE_ONLY_SQL,
  HEALTH_WINDOW_DAYS,
  MIN_ATTEMPTED_FOR_ENFORCEMENT,
  MIN_BOUNCED_FOR_PAUSE,
  MIN_COMPLAINED_FOR_PAUSE,
  TX_BAD_ADDRESS_COUNT_SQL,
  computeAccountHealth,
} from "./health";

// The per-outcome aggregate both send-ledger views share. Counts come from the
// per-recipient timestamp columns (sent_at, delivered_at, …) rather than the
// single `status` column, because an email can be delivered AND complained AND
// unsubscribed — those outcomes overlap, and `status` only holds the latest one.
// Timestamp-presence counts each outcome independently, which is what
// funnel/rate metrics need.
//
// `failed`/`skipped` have no timestamp (they're pre/at-send outcomes, not
// post-send feedback), so those two are still counted off `status`.
const RECIPIENT_COUNT_FIELDS = {
  recipients: sql<number>`count(*)`,
  sent: sql<number>`count(*) filter (where ${campaignRecipients.sentAt} is not null)`,
  delivered: sql<number>`count(*) filter (where ${campaignRecipients.deliveredAt} is not null)`,
  opened: sql<number>`count(*) filter (where ${campaignRecipients.openedAt} is not null)`,
  clicked: sql<number>`count(*) filter (where ${campaignRecipients.clickedAt} is not null)`,
  bounced: sql<number>`count(*) filter (where ${campaignRecipients.bouncedAt} is not null)`,
  complained: sql<number>`count(*) filter (where ${campaignRecipients.complainedAt} is not null)`,
  unsubscribed: sql<number>`count(*) filter (where ${campaignRecipients.unsubscribedAt} is not null)`,
  failed: sql<number>`count(*) filter (where ${campaignRecipients.status} = 'failed')`,
  skipped: sql<number>`count(*) filter (where ${campaignRecipients.status} = 'skipped')`,
} as const;

// A raw `max(ts)` bypasses the tstz column's mode:"string" mapper and comes back
// in Postgres's own local-offset rendering ("2026-09-08 00:56:43.665+01"). Every
// timestamp this app puts on the wire is an ISO-8601 UTC string that crosses the
// server/client boundary as-is (AGENTS.md), and the Postgres form is not a
// format `new Date()` is required to parse — Safari returns Invalid Date for it.
// So the aggregate is formatted where it is computed.
const isoMax = (col: PgColumn) =>
  sql<string | null>`to_char(max(${col}) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

type RawRecipientCounts = Record<keyof CampaignMetricCounts, unknown>;

function toCounts(r: RawRecipientCounts): CampaignMetricCounts {
  return {
    recipients: Number(r.recipients),
    sent: Number(r.sent),
    delivered: Number(r.delivered),
    opened: Number(r.opened),
    clicked: Number(r.clicked),
    bounced: Number(r.bounced),
    complained: Number(r.complained),
    unsubscribed: Number(r.unsubscribed),
    failed: Number(r.failed),
    skipped: Number(r.skipped),
  };
}

// Per-campaign send metrics for an account, one row per campaign that has at
// least one recipient. See RECIPIENT_COUNT_FIELDS for how the outcomes are
// counted.
//
// Account-scoped (hard rule). The page sums these rows for the global view and
// picks one for the per-campaign view, recomputing rates client-side — so the
// campaign filter never costs a round trip.
export async function accountCampaignMetrics(
  db: Db,
  accountId: string,
): Promise<CampaignMetricsRow[]> {
  const rows = await db
    .select({
      // From the joined campaign, not from the recipient row: the send ledger is
      // shared with automations now, so campaign_recipients.campaign_id is
      // nullable. The inner join already drops automation sends (they belong to
      // the automation's own per-node stats, not to a campaign row); taking the
      // id from `campaigns` says so in the type as well.
      campaignId: campaigns.id,
      name: campaigns.name,
      status: campaigns.status,
      // Sandbox sends are real sends and belong in the numbers — they bounce,
      // open and click like anything else, and hiding them would make a free
      // account's metrics page look broken. Surfaced so the row can say what it
      // is rather than passing a team-of-five send off as audience reach.
      sandbox: campaigns.sandbox,
      sentAt: campaigns.sentAt,
      ...RECIPIENT_COUNT_FIELDS,
    })
    .from(campaignRecipients)
    .innerJoin(campaigns, eq(campaigns.id, campaignRecipients.campaignId))
    .where(eq(campaignRecipients.accountId, accountId))
    .groupBy(
      campaigns.id,
      campaigns.name,
      campaigns.status,
      campaigns.sandbox,
      campaigns.sentAt,
    )
    // Most recently sent first; campaigns mid-send (no sent_at yet) sort last.
    .orderBy(sql`${campaigns.sentAt} desc nulls last`);

  return rows.map((r) => ({
    campaignId: r.campaignId,
    name: r.name,
    status: r.status,
    sandbox: r.sandbox,
    sentAt: r.sentAt,
    counts: toCounts(r),
  }));
}

// Per-automation send metrics, the direct analogue of accountCampaignMetrics on
// the other half of the shared ledger. Automation sends live in
// `campaign_recipients` with `campaign_id` NULL and `automation_id` set (see
// AGENTS.md — the table name is a misnomer), so the only differences are which
// side the inner join is on and that an automation has no single `sent_at`:
// it sends continuously, so "last sent" is the max over its rows.
export async function accountAutomationMetrics(
  db: Db,
  accountId: string,
): Promise<AutomationMetricsRow[]> {
  const rows = await db
    .select({
      automationId: automations.id,
      name: automations.name,
      status: automations.status,
      sandbox: automations.sandbox,
      lastSentAt: isoMax(campaignRecipients.sentAt),
      ...RECIPIENT_COUNT_FIELDS,
    })
    .from(campaignRecipients)
    .innerJoin(automations, eq(automations.id, campaignRecipients.automationId))
    .where(eq(campaignRecipients.accountId, accountId))
    .groupBy(automations.id, automations.name, automations.status, automations.sandbox)
    .orderBy(sql`max(${campaignRecipients.sentAt}) desc nulls last`);

  return rows.map((r) => ({
    automationId: r.automationId,
    name: r.name,
    status: r.status,
    sandbox: r.sandbox,
    lastSentAt: r.lastSentAt,
    counts: toCounts(r),
  }));
}

/* ─────────────────────── transactional (API) sends ─────────────────────── */

// Transactional mail is metered in ADDRESSES, not messages: one message carries
// up to MAX_TRANSACTIONAL_RECIPIENTS visible To addresses, the quota reserves
// `to.length`, and SES counts every one of them. So volume weighs
// jsonb_array_length(to) — the same unit the bandwidth meter and the reputation
// guard use — while `messages` is kept alongside it as the API-call count,
// because "3,400 emails over 3,400 calls" and "3,400 emails over 68 calls" are
// very different integrations.
const TX_UNITS = sql<number>`coalesce(sum(jsonb_array_length(${transactionalEmails.to})), 0)`;

const txUnitsWhere = (predicate: ReturnType<typeof sql>) =>
  sql<number>`coalesce(sum(jsonb_array_length(${transactionalEmails.to})) filter (where ${predicate}), 0)`;

const TX_LEDGER_FIELDS = {
  messages: sql<number>`count(*)`,
  emails: TX_UNITS,
  sent: txUnitsWhere(sql`${transactionalEmails.sentAt} is not null`),
  delivered: txUnitsWhere(sql`${transactionalEmails.deliveredAt} is not null`),
  // Pre-send outcomes. These are whole-message facts — the message never reached
  // the provider at all — so weighing every address of it is exact, not an
  // approximation. This is the transactional-specific health signal: unlike a
  // bounce it means the integration is broken (unverified From domain, rejected
  // sender, an address already on the suppression list), not that the list is.
  failed: txUnitsWhere(sql`${transactionalEmails.status} = 'failed'`),
  suppressed: txUnitsWhere(sql`${transactionalEmails.status} = 'suppressed'`),
  queued: txUnitsWhere(sql`${transactionalEmails.status} in ('queued', 'sending')`),
} as const;

// Bounces and complaints are NOT read off the message row here. A bounce for any
// one recipient flips the whole message's status, so a 50-address message with
// one dead mailbox would read as 50 bounces — the exact bug services/health.ts
// documents. email_events holds one row per (message, address, event type), so
// it is counted from there, through the same two shared predicates the
// reputation guard uses. That is deliberate: the Reputation card and the
// Transactional card sit on one screen, and they must not be able to disagree
// about how many addresses went wrong.
async function transactionalBadAddresses(
  db: Db,
  accountId: string,
): Promise<Map<string, { bounced: number; complained: number }>> {
  const rows = await db
    .select({
      fromEmail: transactionalEmails.fromEmail,
      eventType: emailEvents.eventType,
      count: TX_BAD_ADDRESS_COUNT_SQL.as("count"),
    })
    .from(emailEvents)
    .innerJoin(transactionalEmails, eq(emailEvents.transactionalEmailId, transactionalEmails.id))
    .where(
      and(
        eq(emailEvents.accountId, accountId),
        inArray(emailEvents.eventType, ["bounce", "complaint"]),
        HARD_BOUNCE_ONLY_SQL,
      ),
    )
    .groupBy(transactionalEmails.fromEmail, emailEvents.eventType);

  const out = new Map<string, { bounced: number; complained: number }>();
  for (const r of rows) {
    const entry = out.get(r.fromEmail) ?? { bounced: 0, complained: 0 };
    if (r.eventType === "bounce") entry.bounced = Number(r.count);
    if (r.eventType === "complaint") entry.complained = Number(r.count);
    out.set(r.fromEmail, entry);
  }
  return out;
}

const ZERO_TX_COUNTS: TransactionalMetricCounts = {
  messages: 0,
  emails: 0,
  sent: 0,
  delivered: 0,
  bounced: 0,
  complained: 0,
  failed: 0,
  suppressed: 0,
  queued: 0,
};

/**
 * Transactional (API) send metrics for an account, broken down by From address.
 *
 * From address rather than tag: `transactional_emails.tags` is optional and most
 * integrations never set it, whereas From is always present and in practice maps
 * to "which app or feature sent this" (billing@, security@, notifications@).
 *
 * Totals are summed from the per-sender rows rather than queried separately, so
 * the card's header can never disagree with its own table.
 */
export async function accountTransactionalMetrics(
  db: Db,
  accountId: string,
): Promise<TransactionalMetrics> {
  const [ledger, bad] = await Promise.all([
    db
      .select({
        fromEmail: transactionalEmails.fromEmail,
        lastSentAt: isoMax(transactionalEmails.sentAt),
        ...TX_LEDGER_FIELDS,
      })
      .from(transactionalEmails)
      .where(eq(transactionalEmails.accountId, accountId))
      .groupBy(transactionalEmails.fromEmail)
      .orderBy(sql`max(${transactionalEmails.sentAt}) desc nulls last`),
    transactionalBadAddresses(db, accountId),
  ]);

  const senders: TransactionalSenderRow[] = ledger.map((r) => {
    const b = bad.get(r.fromEmail);
    return {
      fromEmail: r.fromEmail,
      lastSentAt: r.lastSentAt,
      counts: {
        messages: Number(r.messages),
        emails: Number(r.emails),
        sent: Number(r.sent),
        delivered: Number(r.delivered),
        bounced: b?.bounced ?? 0,
        complained: b?.complained ?? 0,
        failed: Number(r.failed),
        suppressed: Number(r.suppressed),
        queued: Number(r.queued),
      },
    };
  });

  const totals = senders.reduce<TransactionalMetricCounts>((acc, s) => {
    (Object.keys(acc) as (keyof TransactionalMetricCounts)[]).forEach((k) => {
      acc[k] += s.counts[k];
    });
    return acc;
  }, { ...ZERO_TX_COUNTS });

  return { totals, senders };
}

/* ──────────────────────────────── reputation ───────────────────────────── */

/**
 * The Reputation card's data: the account-wide, windowed rates that the
 * auto-pause itself computes, plus the thresholds it enforces and the split by
 * producer.
 *
 * This deliberately does NOT derive anything from the campaign rows above. The
 * page used to show a lifetime, campaign-only bounce rate next to SES's
 * published 5% / 0.1% review thresholds, while the thing that actually stops an
 * account measures every source over a trailing window against a stricter bar —
 * so a customer whose API sends were sinking their reputation read "Healthy"
 * right up to the moment sending stopped. One number, one source.
 *
 * `computeAccountHealth` is the read; enforcement (`enforceAccountHealth`) stays
 * on the send path where it belongs — looking at the page must never pause an
 * account.
 */
export async function accountReputation(db: Db, accountId: string): Promise<ReputationSummary> {
  const health = await computeAccountHealth(db, accountId);
  return {
    windowDays: HEALTH_WINDOW_DAYS,
    attempted: health.attempted,
    bounced: health.bounced,
    complained: health.complained,
    bounceRate: health.bounceRate,
    complaintRate: health.complaintRate,
    status: health.status,
    reason: health.reason ?? null,
    bySource: health.bySource,
    thresholds: {
      minAttempted: MIN_ATTEMPTED_FOR_ENFORCEMENT,
      bounceWarn: BOUNCE_RATE_WARNING,
      bouncePause: BOUNCE_RATE_PAUSE,
      minBounced: MIN_BOUNCED_FOR_PAUSE,
      complaintWarn: COMPLAINT_RATE_WARNING,
      complaintPause: COMPLAINT_RATE_PAUSE,
      minComplained: MIN_COMPLAINED_FOR_PAUSE,
    },
  };
}
