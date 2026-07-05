import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { topicSubscriptions } from "../db/schema";
import { newId, nowIso } from "../lib/ids";

// Record a subscriber's explicit topic choice (idempotent upsert on the
// (topic, subscriber) pair). Used by the subscriber edit dialog and by the
// public unsubscribe page's "just this topic" action.
export async function setTopicSubscription(
  db: Db,
  input: { accountId: string; topicId: string; subscriberId: string; subscribed: boolean },
): Promise<void> {
  const now = nowIso();
  const updated = await db
    .update(topicSubscriptions)
    .set({ subscribed: input.subscribed, updatedAt: now })
    .where(
      and(
        eq(topicSubscriptions.topicId, input.topicId),
        eq(topicSubscriptions.subscriberId, input.subscriberId),
      ),
    )
    .returning({ id: topicSubscriptions.id });
  if (updated.length > 0) return;

  // No row yet — insert; a concurrent insert loses to the unique index and is
  // simply dropped (the states race to the same user intent anyway).
  await db
    .insert(topicSubscriptions)
    .values({
      id: newId("tsub"),
      accountId: input.accountId,
      topicId: input.topicId,
      subscriberId: input.subscriberId,
      subscribed: input.subscribed,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
}
