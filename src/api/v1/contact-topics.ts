import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { topicSubscriptions, topics } from "../../db/schema";

// A contact's EFFECTIVE topic state: explicit subscription rows overlaid on
// each topic's default. `is_default` distinguishes "never chose" from "chose
// the same value as the default".
export async function effectiveTopics(
  db: Db,
  accountId: string,
  audienceId: string,
  subscriberId: string,
): Promise<Array<{ topic_id: string; name: string; subscribed: boolean; is_default: boolean }>> {
  const topicRows = await db
    .select()
    .from(topics)
    .where(and(eq(topics.accountId, accountId), eq(topics.audienceId, audienceId)))
    .orderBy(asc(topics.createdAt));
  if (topicRows.length === 0) return [];

  const overrides = await db
    .select()
    .from(topicSubscriptions)
    .where(
      and(
        eq(topicSubscriptions.subscriberId, subscriberId),
        inArray(
          topicSubscriptions.topicId,
          topicRows.map((t) => t.id),
        ),
      ),
    );
  const overrideByTopic = new Map(overrides.map((o) => [o.topicId, o.subscribed]));

  return topicRows.map((t) => ({
    topic_id: t.id,
    name: t.name,
    subscribed: overrideByTopic.get(t.id) ?? t.defaultSubscribed,
    is_default: !overrideByTopic.has(t.id),
  }));
}
