import type {
  Audience,
  AudienceField,
  Segment,
  Subscriber,
  SuppressionEntry,
  SuppressionReason,
  Topic,
} from "../../db/schema";
import { safeParseSegmentFilter, type SegmentFilter } from "../../lib/segment-filter";

// Row → public v1 shape. The public API is snake_case and never leaks raw
// Drizzle rows: every response field below is a deliberate contract. Clients
// are told to ignore unknown fields, so additions here are non-breaking.

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
    created_at: a.createdAt,
    updated_at: a.updatedAt,
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
    unsubscribed_at: s.unsubscribedAt,
    created_at: s.createdAt,
    updated_at: s.updatedAt,
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
    created_at: f.createdAt,
    updated_at: f.updatedAt,
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
    created_at: s.createdAt,
    updated_at: s.updatedAt,
  };
}

export function serializeTopic(t: Topic): Record<string, unknown> {
  return {
    id: t.id,
    object: "topic",
    name: t.name,
    description: t.description,
    default_subscribed: t.defaultSubscribed,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
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

export function serializeSuppression(e: SuppressionEntry): Record<string, unknown> {
  return {
    id: e.id,
    object: "suppression",
    email: e.email,
    reason: REASON_TO_PUBLIC[e.reason] ?? e.reason,
    source: e.source,
    created_at: e.createdAt,
  };
}
