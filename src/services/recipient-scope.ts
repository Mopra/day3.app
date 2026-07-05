import { and, eq, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { segments, topics } from "../db/schema";
import { safeParseSegmentFilter, segmentFilterCondition } from "../lib/segment-filter";

// Resolves a campaign's audience narrowing — its optional segment and topic —
// into SQL conditions to AND onto a `subscribers` query (the caller adds the
// account/audience/status scoping). One resolver shared by the send gate, the
// personalization estimate, and recipient generation, so "who will receive
// this" is computed identically everywhere.
//
// A dangling reference (segment/topic deleted after the campaign was scheduled;
// the delete routes block this for in-flight campaigns, so it's a belt-and-
// braces path) or a corrupt stored filter returns `error` — callers must treat
// that as "cannot send", never as "send to everyone".
export async function campaignRecipientScope(
  db: Db,
  campaign: { accountId: string; segmentId?: string | null; topicId?: string | null },
): Promise<{ conditions: SQL[]; error: string | null }> {
  const conditions: SQL[] = [];

  if (campaign.segmentId) {
    const segment = await db.query.segments.findFirst({
      where: and(eq(segments.id, campaign.segmentId), eq(segments.accountId, campaign.accountId)),
    });
    if (!segment) {
      return { conditions, error: "The segment this campaign targets no longer exists" };
    }
    const filter = safeParseSegmentFilter(segment.filterJson);
    if (!filter) {
      return { conditions, error: `The segment "${segment.name}" has an invalid filter` };
    }
    conditions.push(segmentFilterCondition(filter));
  }

  if (campaign.topicId) {
    const topic = await db.query.topics.findFirst({
      where: and(eq(topics.id, campaign.topicId), eq(topics.accountId, campaign.accountId)),
    });
    if (!topic) {
      return { conditions, error: "The topic this campaign is sent under no longer exists" };
    }
    // Outer columns are written literally inside the raw subquery: an
    // interpolated Drizzle column renders UNQUALIFIED in single-table selects,
    // so `subscribers.id` interpolated here would resolve against
    // topic_subscriptions and the correlation would be lost.
    conditions.push(
      topic.defaultSubscribed
        ? // Opt-out model: everyone except those who explicitly left the topic.
          sql`not exists (
            select 1 from topic_subscriptions ts
            where ts.topic_id = ${topic.id}
              and ts.subscriber_id = subscribers.id
              and ts.subscribed = false
          )`
        : // Opt-in model: only those who explicitly joined.
          sql`exists (
            select 1 from topic_subscriptions ts
            where ts.topic_id = ${topic.id}
              and ts.subscriber_id = subscribers.id
              and ts.subscribed = true
          )`,
    );
  }

  return { conditions, error: null };
}
