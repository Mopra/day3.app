import { and, asc, eq, ilike, inArray, isNotNull, isNull, like, or, sql, type SQL } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import type { Db } from "../db/client";
import {
  automations,
  campaignRecipients,
  campaigns,
  emailEvents,
  transactionalEmails,
  type RecipientStatus,
  type TransactionalEmailStatus,
} from "../db/schema";
import type { ActivitySend, ActivitySendEvent, ActivitySource } from "../lib/types";

// The Activity page: every email the account sent, whichever producer sent it,
// as ONE list newest-first. It is a union of the two send ledgers:
//
//   campaign_recipients  — campaign sends (campaign_id set) and automation sends
//                          (automation_id set); one row per recipient
//   transactional_emails — API sends (POST /v1/emails); one row per message
//
// Both are projected onto the same row shape (ActivitySend) so the page can
// show, filter and page them together. `status` is normalised to one shared
// vocabulary (ACTIVITY_STATUSES) and each status filter is translated back into
// each ledger's own values below. The event timeline for one row is a separate
// read (getActivitySend), keyed by whichever id column the events carry.

export const ACTIVITY_SOURCES = ["campaign", "automation", "api"] as const;

export const ACTIVITY_STATUSES = [
  "queued",
  "sent",
  "delivered",
  "opened",
  "clicked",
  "bounced",
  "complained",
  "unsubscribed",
  "failed",
  "suppressed",
  "skipped",
] as const;
export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

// Which ledger statuses a shared status filter means on each side. `opened` /
// `clicked` are engagement flags on a delivered campaign row rather than a
// status of their own, so they filter on the stamped timestamp instead; API
// sends carry no open tracking, so those two match nothing there.
const RECIPIENT_STATUS_FILTER: Record<ActivityStatus, RecipientStatus[] | "opened" | "clicked"> = {
  queued: ["pending", "sending"],
  sent: ["sent"],
  delivered: ["delivered"],
  opened: "opened",
  clicked: "clicked",
  bounced: ["bounced"],
  complained: ["complained"],
  unsubscribed: ["unsubscribed"],
  failed: ["failed"],
  suppressed: [],
  skipped: ["skipped"],
};

const TRANSACTIONAL_STATUS_FILTER: Record<ActivityStatus, TransactionalEmailStatus[]> = {
  queued: ["queued", "sending"],
  sent: ["sent"],
  delivered: ["delivered"],
  opened: [],
  clicked: [],
  bounced: ["bounced"],
  complained: ["complained"],
  unsubscribed: [],
  failed: ["failed"],
  suppressed: ["suppressed"],
  skipped: [],
};

export type ActivityFilters = {
  source?: ActivitySource;
  status?: ActivityStatus;
  campaignId?: string;
  automationId?: string;
  /** Substring match against the recipient email (and, for API sends, the subject). */
  search?: string;
  limit: number;
  offset: number;
};

// Escape LIKE metacharacters so a user's `%` or `_` narrows the search the way
// they typed it instead of widening the scan.
function likeTerm(raw: string): string {
  return `%${raw.trim().toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
}

// The recipient ledger normalised onto the shared status vocabulary. Ledger
// statuses that already match pass straight through; only `pending` renames.
const recipientStatusSql = sql<string>`case ${campaignRecipients.status} when 'pending' then 'queued' when 'sending' then 'queued' else ${campaignRecipients.status} end`;
const transactionalStatusSql = sql<string>`case ${transactionalEmails.status} when 'sending' then 'queued' else ${transactionalEmails.status} end`;

function recipientConditions(accountId: string, f: ActivityFilters): SQL[] | null {
  if (f.source === "api") return null;
  const conds: SQL[] = [eq(campaignRecipients.accountId, accountId)];
  if (f.source === "campaign") conds.push(isNotNull(campaignRecipients.campaignId));
  if (f.source === "automation") conds.push(isNotNull(campaignRecipients.automationId));
  if (f.campaignId) conds.push(eq(campaignRecipients.campaignId, f.campaignId));
  if (f.automationId) conds.push(eq(campaignRecipients.automationId, f.automationId));
  if (f.status) {
    const rule = RECIPIENT_STATUS_FILTER[f.status];
    if (rule === "opened") conds.push(isNotNull(campaignRecipients.openedAt));
    else if (rule === "clicked") conds.push(isNotNull(campaignRecipients.clickedAt));
    else if (rule.length === 0) return null;
    else conds.push(inArray(campaignRecipients.status, rule));
  }
  if (f.search) {
    // Recipient emails are stored lowercase; same substring idiom as the
    // subscribers list.
    conds.push(like(campaignRecipients.email, likeTerm(f.search)));
  }
  return conds;
}

function transactionalConditions(accountId: string, f: ActivityFilters): SQL[] | null {
  if (f.source === "campaign" || f.source === "automation") return null;
  // A campaign/automation pick is a campaign-side filter by definition.
  if (f.campaignId || f.automationId) return null;
  const conds: SQL[] = [eq(transactionalEmails.accountId, accountId)];
  if (f.status) {
    const statuses = TRANSACTIONAL_STATUS_FILTER[f.status];
    if (statuses.length === 0) return null;
    conds.push(inArray(transactionalEmails.status, statuses));
  }
  if (f.search) {
    const term = likeTerm(f.search);
    conds.push(
      or(
        ilike(transactionalEmails.subject, term),
        // `to` is a jsonb string array; its text rendering contains the
        // addresses, which is exactly what a substring search needs.
        sql`${transactionalEmails.to}::text ilike ${term}`,
      )!,
    );
  }
  return conds;
}

export async function listAccountActivity(
  db: Db,
  accountId: string,
  filters: ActivityFilters,
): Promise<{ sends: ActivitySend[]; total: number }> {
  const recipientWhere = recipientConditions(accountId, filters);
  const transactionalWhere = transactionalConditions(accountId, filters);

  // Both selects project the identical column list, in the same order, so the
  // UNION ALL lines up. Columns one side doesn't have are typed NULLs.
  const recipientSelect = db
    .select({
      id: campaignRecipients.id,
      source: sql<ActivitySource>`case when ${campaignRecipients.automationId} is not null then 'automation' else 'campaign' end`.as("source"),
      email: campaignRecipients.email,
      recipientCount: sql<number>`1`.as("recipient_count"),
      subject: sql<string | null>`null::text`.as("subject"),
      fromEmail: sql<string | null>`null::text`.as("from_email"),
      status: recipientStatusSql.as("status"),
      campaignId: campaignRecipients.campaignId,
      campaignName: campaigns.name,
      automationId: campaignRecipients.automationId,
      automationName: automations.name,
      error: campaignRecipients.error,
      sandbox: sql<boolean>`coalesce(${campaigns.sandbox}, false)`.as("sandbox"),
      providerMessageId: campaignRecipients.providerMessageId,
      createdAt: campaignRecipients.createdAt,
      sentAt: campaignRecipients.sentAt,
      deliveredAt: campaignRecipients.deliveredAt,
      openedAt: campaignRecipients.openedAt,
      clickedAt: campaignRecipients.clickedAt,
      bouncedAt: campaignRecipients.bouncedAt,
      complainedAt: campaignRecipients.complainedAt,
      unsubscribedAt: campaignRecipients.unsubscribedAt,
    })
    .from(campaignRecipients)
    .leftJoin(campaigns, eq(campaigns.id, campaignRecipients.campaignId))
    .leftJoin(automations, eq(automations.id, campaignRecipients.automationId))
    .where(and(...(recipientWhere ?? [sql`false`])));

  const transactionalSelect = db
    .select({
      id: transactionalEmails.id,
      source: sql<ActivitySource>`'api'`.as("source"),
      email: sql<string>`coalesce(${transactionalEmails.to}->>0, '')`.as("email"),
      recipientCount: sql<number>`jsonb_array_length(${transactionalEmails.to})`.as("recipient_count"),
      subject: sql<string | null>`${transactionalEmails.subject}`.as("subject"),
      fromEmail: sql<string | null>`${transactionalEmails.fromEmail}`.as("from_email"),
      status: transactionalStatusSql.as("status"),
      campaignId: sql<string | null>`null::text`.as("campaign_id"),
      campaignName: sql<string | null>`null::text`.as("campaign_name"),
      automationId: sql<string | null>`null::text`.as("automation_id"),
      automationName: sql<string | null>`null::text`.as("automation_name"),
      error: transactionalEmails.error,
      sandbox: transactionalEmails.sandbox,
      providerMessageId: transactionalEmails.providerMessageId,
      createdAt: transactionalEmails.createdAt,
      sentAt: transactionalEmails.sentAt,
      deliveredAt: transactionalEmails.deliveredAt,
      openedAt: sql<string | null>`null::timestamptz`.as("opened_at"),
      clickedAt: sql<string | null>`null::timestamptz`.as("clicked_at"),
      bouncedAt: transactionalEmails.bouncedAt,
      complainedAt: transactionalEmails.complainedAt,
      unsubscribedAt: sql<string | null>`null::timestamptz`.as("unsubscribed_at"),
    })
    .from(transactionalEmails)
    .where(and(...(transactionalWhere ?? [sql`false`])));

  // Only union what the filters can actually match; a side ruled out entirely
  // (e.g. source=api) is skipped rather than scanned. id tie-breaks equal
  // timestamps (batch inserts share one) so offset pagination never skips or
  // repeats a row across either side.
  if (!recipientWhere && !transactionalWhere) return { sends: [], total: 0 };
  const order = [sql`created_at desc`, sql`id desc`];
  const rows =
    recipientWhere && transactionalWhere
      ? await unionAll(recipientSelect, transactionalSelect)
          .orderBy(...order)
          .limit(filters.limit)
          .offset(filters.offset)
      : recipientWhere
        ? await recipientSelect.orderBy(...order).limit(filters.limit).offset(filters.offset)
        : await transactionalSelect.orderBy(...order).limit(filters.limit).offset(filters.offset);

  const counts = await Promise.all([
    recipientWhere
      ? db
          .select({ n: sql<number>`count(*)` })
          .from(campaignRecipients)
          .where(and(...recipientWhere))
          .then(([r]) => Number(r.n))
      : 0,
    transactionalWhere
      ? db
          .select({ n: sql<number>`count(*)` })
          .from(transactionalEmails)
          .where(and(...transactionalWhere))
          .then(([r]) => Number(r.n))
      : 0,
  ]);

  return {
    sends: rows.map((r) => ({
      ...r,
      recipientCount: Number(r.recipientCount),
      sandbox: !!r.sandbox,
    })) as ActivitySend[],
    total: counts[0] + counts[1],
  };
}

// One send with its event timeline, for the Activity drawer. `source` says
// which ledger the id belongs to; a transactional row also returns its full
// content (bodies survive until the retention prune).
export async function getActivitySend(
  db: Db,
  accountId: string,
  source: ActivitySource,
  id: string,
): Promise<{
  send: ActivitySend;
  events: ActivitySendEvent[];
  email: (typeof transactionalEmails.$inferSelect) | null;
} | null> {
  const eventColumns = {
    id: emailEvents.id,
    eventType: emailEvents.eventType,
    email: emailEvents.email,
    payloadJson: emailEvents.payloadJson,
    createdAt: emailEvents.createdAt,
  };

  if (source === "api") {
    const email = await db.query.transactionalEmails.findFirst({
      where: and(eq(transactionalEmails.id, id), eq(transactionalEmails.accountId, accountId)),
    });
    if (!email) return null;
    const events = await db
      .select(eventColumns)
      .from(emailEvents)
      .where(and(eq(emailEvents.accountId, accountId), eq(emailEvents.transactionalEmailId, id)))
      .orderBy(asc(emailEvents.createdAt), asc(emailEvents.id))
      .limit(100);
    const send: ActivitySend = {
      id: email.id,
      source: "api",
      email: email.to[0] ?? "",
      recipientCount: email.to.length,
      subject: email.subject,
      fromEmail: email.fromEmail,
      status: email.status === "sending" ? "queued" : email.status,
      campaignId: null,
      campaignName: null,
      automationId: null,
      automationName: null,
      error: email.error,
      sandbox: email.sandbox,
      providerMessageId: email.providerMessageId,
      createdAt: email.createdAt,
      sentAt: email.sentAt,
      deliveredAt: email.deliveredAt,
      openedAt: null,
      clickedAt: null,
      bouncedAt: email.bouncedAt,
      complainedAt: email.complainedAt,
      unsubscribedAt: null,
    };
    return { send, events, email };
  }

  const [row] = await db
    .select({
      recipient: campaignRecipients,
      campaignName: campaigns.name,
      campaignSandbox: campaigns.sandbox,
      automationName: automations.name,
    })
    .from(campaignRecipients)
    .leftJoin(campaigns, eq(campaigns.id, campaignRecipients.campaignId))
    .leftJoin(automations, eq(automations.id, campaignRecipients.automationId))
    .where(
      and(
        eq(campaignRecipients.id, id),
        eq(campaignRecipients.accountId, accountId),
        source === "automation"
          ? isNotNull(campaignRecipients.automationId)
          : isNull(campaignRecipients.automationId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const r = row.recipient;
  const events = await db
    .select(eventColumns)
    .from(emailEvents)
    .where(and(eq(emailEvents.accountId, accountId), eq(emailEvents.campaignRecipientId, id)))
    .orderBy(asc(emailEvents.createdAt), asc(emailEvents.id))
    .limit(100);
  const send: ActivitySend = {
    id: r.id,
    source,
    email: r.email,
    recipientCount: 1,
    subject: null,
    fromEmail: null,
    status: r.status === "pending" || r.status === "sending" ? "queued" : r.status,
    campaignId: r.campaignId,
    campaignName: row.campaignName,
    automationId: r.automationId,
    automationName: row.automationName,
    error: r.error,
    sandbox: !!row.campaignSandbox,
    providerMessageId: r.providerMessageId,
    createdAt: r.createdAt,
    sentAt: r.sentAt,
    deliveredAt: r.deliveredAt,
    openedAt: r.openedAt,
    clickedAt: r.clickedAt,
    bouncedAt: r.bouncedAt,
    complainedAt: r.complainedAt,
    unsubscribedAt: r.unsubscribedAt,
  };
  return { send, events, email: null };
}
