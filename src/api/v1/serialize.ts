import type {
  Audience,
  AudienceField,
  Segment,
  Subscriber,
  SuppressionEntry,
  SuppressionReason,
  Topic,
  TransactionalEmail,
} from "../../db/schema";
import { safeParseSegmentFilter, type SegmentFilter } from "../../lib/segment-filter";

// Row → public v1 shape. The public API is snake_case and never leaks raw
// Drizzle rows: every response field below is a deliberate contract. Clients
// are told to ignore unknown fields, so additions here are non-breaking.

// Timestamp columns are `timestamptz` read in Drizzle's `mode: "string"`, so a
// row carries Postgres' own rendering — "2026-07-29 11:37:42.401+01": a space
// separator, a short offset, and whatever timezone the server session happens
// to be in. The documented contract is ISO-8601 UTC, and strict parsers
// (Python's pre-3.11 fromisoformat, Go's time.RFC3339) reject the raw form, so
// normalize here — the single boundary where rows become responses.
//
// Cursors deliberately keep the raw column value (see pagination.ts): they are
// compared against the column, not handed to a client as a timestamp.
export function toIso(value: string | null): string | null {
  if (!value) return value;
  let parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    // "…T…+01" for engines stricter than V8 about the Date Time String Format.
    parsed = new Date(value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"));
  }
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

export function serializeAudience(
  a: Audience,
  contactCounts?: Record<string, number>,
): Record<string, unknown> {
  return {
    id: a.id,
    object: "audience",
    name: a.name,
    ...(contactCounts
      ? {
          contact_counts: {
            ...contactCounts,
            total: Object.values(contactCounts).reduce((sum, n) => sum + n, 0),
          },
        }
      : {}),
    created_at: toIso(a.createdAt),
    updated_at: toIso(a.updatedAt),
  };
}

export function serializeContact(
  s: Subscriber,
  topics?: Array<{ topic_id: string; name: string; subscribed: boolean; is_default: boolean }>,
): Record<string, unknown> {
  return {
    id: s.id,
    object: "contact",
    email: s.email,
    first_name: s.firstName,
    last_name: s.lastName,
    attributes: s.attributes ?? {},
    status: s.status,
    source: s.source,
    topics: topics ?? null,
    unsubscribed_at: toIso(s.unsubscribedAt),
    created_at: toIso(s.createdAt),
    updated_at: toIso(s.updatedAt),
  };
}

export function serializeField(f: AudienceField): Record<string, unknown> {
  return {
    id: f.id,
    object: "field",
    key: f.key,
    label: f.label,
    type: f.type,
    fallback: f.fallback,
    created_at: toIso(f.createdAt),
    updated_at: toIso(f.updatedAt),
  };
}

export function serializeSegment(s: Segment): Record<string, unknown> {
  return {
    id: s.id,
    object: "segment",
    name: s.name,
    // Stored filters are validated on write, so a parse failure here means a
    // corrupt row; surface it as null rather than guessing.
    filter: safeParseSegmentFilter(s.filterJson) as SegmentFilter | null,
    created_at: toIso(s.createdAt),
    updated_at: toIso(s.updatedAt),
  };
}

export function serializeTopic(t: Topic): Record<string, unknown> {
  return {
    id: t.id,
    object: "topic",
    name: t.name,
    description: t.description,
    default_subscribed: t.defaultSubscribed,
    created_at: toIso(t.createdAt),
    updated_at: toIso(t.updatedAt),
  };
}

// Suppression reasons: the public vocabulary is past-tense and matches the
// contact-status words; internal rows keep the pipeline's names.
const REASON_TO_PUBLIC: Record<SuppressionReason, string> = {
  unsubscribe: "unsubscribed",
  hard_bounce: "bounced",
  complaint: "complained",
  manual: "manual",
  provider_suppressed: "provider_suppressed",
};

export const PUBLIC_SUPPRESSION_REASONS = ["unsubscribed", "bounced", "complained"] as const;
export type PublicSuppressionReason = (typeof PUBLIC_SUPPRESSION_REASONS)[number];

export const PUBLIC_TO_REASON: Record<PublicSuppressionReason, SuppressionReason> = {
  unsubscribed: "unsubscribe",
  bounced: "hard_bounce",
  complained: "complaint",
};

// The public status vocabulary hides `sending` (a worker-claim implementation
// detail measured in milliseconds): callers see `queued` until the provider
// accepted the message.
export function publicEmailStatus(status: TransactionalEmail["status"]): string {
  return status === "sending" ? "queued" : status;
}

export function serializeEmail(
  e: TransactionalEmail,
  events?: Array<{ eventType: string; createdAt: string }>,
): Record<string, unknown> {
  return {
    id: e.id,
    object: "email",
    from: e.fromName ? `${e.fromName} <${e.fromEmail}>` : e.fromEmail,
    to: e.to,
    reply_to: e.replyTo,
    subject: e.subject,
    status: publicEmailStatus(e.status),
    error: e.error,
    tags: e.tags ?? {},
    sandbox: e.sandbox,
    created_at: toIso(e.createdAt),
    sent_at: toIso(e.sentAt),
    delivered_at: toIso(e.deliveredAt),
    bounced_at: toIso(e.bouncedAt),
    complained_at: toIso(e.complainedAt),
    ...(events
      ? { events: events.map((ev) => ({ type: ev.eventType, created_at: toIso(ev.createdAt) })) }
      : {}),
  };
}

export function serializeSuppression(e: SuppressionEntry): Record<string, unknown> {
  return {
    id: e.id,
    object: "suppression",
    email: e.email,
    reason: REASON_TO_PUBLIC[e.reason] ?? e.reason,
    source: e.source,
    created_at: toIso(e.createdAt),
  };
}
