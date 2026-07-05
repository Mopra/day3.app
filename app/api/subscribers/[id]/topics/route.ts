import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findSubscriber } from "@/api/finders";
import { topics, topicSubscriptions } from "@/db/schema";
import { setTopicSubscription } from "@/services/topic-subscription";

// GET /api/subscribers/[id]/topics — the subscriber's effective topic
// subscriptions: every topic on their audience with the resolved state
// (their explicit choice, or the topic's default when they never chose).
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const subscriber = await findSubscriber(db, account.id, id);
  if (!subscriber) throw new HttpError(404, "Not found");

  const topicRows = await db
    .select()
    .from(topics)
    .where(and(eq(topics.accountId, account.id), eq(topics.audienceId, subscriber.audienceId)))
    .orderBy(asc(topics.createdAt));
  if (topicRows.length === 0) return json({ topics: [] });

  const overrides = await db
    .select()
    .from(topicSubscriptions)
    .where(
      and(
        eq(topicSubscriptions.subscriberId, subscriber.id),
        inArray(
          topicSubscriptions.topicId,
          topicRows.map((t) => t.id),
        ),
      ),
    );
  const overrideByTopic = new Map(overrides.map((o) => [o.topicId, o.subscribed]));

  return json({
    topics: topicRows.map((t) => ({
      id: t.id,
      name: t.name,
      description: t.description,
      subscribed: overrideByTopic.get(t.id) ?? t.defaultSubscribed,
    })),
  });
});

const PatchSchema = z.object({
  // topicId → desired subscribed state; topics not mentioned are left alone.
  subscriptions: z.record(z.string().max(100), z.boolean()),
});

// PATCH /api/subscribers/[id]/topics — set the subscriber's topic choices (from
// the edit dialog). Only topics on the subscriber's audience are accepted.
export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const subscriber = await findSubscriber(db, account.id, id);
  if (!subscriber) throw new HttpError(404, "Not found");

  const { subscriptions } = await parseJson(req, PatchSchema);
  const topicIds = Object.keys(subscriptions);
  if (topicIds.length === 0) return json({ ok: true });

  const topicRows = await db
    .select()
    .from(topics)
    .where(
      and(
        eq(topics.accountId, account.id),
        eq(topics.audienceId, subscriber.audienceId),
        inArray(topics.id, topicIds),
      ),
    );
  const valid = new Set(topicRows.map((t) => t.id));
  for (const topicId of topicIds) {
    if (!valid.has(topicId)) throw new HttpError(400, "Unknown topic");
    await setTopicSubscription(db, {
      accountId: account.id,
      topicId,
      subscriberId: subscriber.id,
      subscribed: subscriptions[topicId],
    });
  }
  return json({ ok: true });
});
