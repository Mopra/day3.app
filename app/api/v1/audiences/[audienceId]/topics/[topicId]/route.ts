import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { requireAudienceV1, requireTopicV1 } from "@/api/v1/finders";
import { serializeTopic } from "@/api/v1/serialize";
import { campaigns, topicSubscriptions, topics } from "@/db/schema";
import { nowIso } from "@/lib/ids";

type Params = { params: Promise<{ audienceId: string; topicId: string }> };

// Campaign statuses where the send pipeline may still read the topic (mirrors
// the internal topic-delete guard).
const ACTIVE_STATUSES = [
  "scheduled",
  "pending_review",
  "approved",
  "generating_recipients",
  "sending",
  "paused",
] as const;

// GET /api/v1/audiences/{id}/topics/{topicId}
export const GET = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { audienceId, topicId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const topic = await requireTopicV1(db, account.id, audience.id, topicId);
  return apiJson(serializeTopic(topic));
});

const PatchTopicSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).nullable().optional(),
  default_subscribed: z.boolean().optional(),
});

// PATCH /api/v1/audiences/{id}/topics/{topicId} — name/description only.
// default_subscribed is immutable (flipping opt-out ↔ opt-in would silently
// invert every stored subscription row).
export const PATCH = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { audienceId, topicId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const topic = await requireTopicV1(db, account.id, audience.id, topicId);
  const body = await readJson(req, PatchTopicSchema);

  if (body.default_subscribed !== undefined && body.default_subscribed !== topic.defaultSubscribed) {
    throw new ApiError(
      422,
      "immutable_field",
      "default_subscribed is immutable — it defines what existing subscription rows mean",
      { param: "default_subscribed" },
    );
  }

  const set: Partial<typeof topics.$inferInsert> = { updatedAt: nowIso() };
  if (body.name !== undefined) set.name = body.name;
  if (body.description !== undefined) set.description = body.description || null;

  const [updated] = await db.update(topics).set(set).where(eq(topics.id, topic.id)).returning();
  return apiJson(serializeTopic(updated));
});

// DELETE /api/v1/audiences/{id}/topics/{topicId} — blocked while a scheduled
// or in-flight campaign sends under the topic; otherwise removes the topic and
// its subscription rows, and clears the reference on drafts/finished campaigns.
export const DELETE = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { audienceId, topicId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const topic = await requireTopicV1(db, account.id, audience.id, topicId);

  const active = await db
    .select({ id: campaigns.id, name: campaigns.name })
    .from(campaigns)
    .where(
      and(
        eq(campaigns.accountId, account.id),
        eq(campaigns.topicId, topic.id),
        inArray(campaigns.status, [...ACTIVE_STATUSES]),
      ),
    );
  if (active.length > 0) {
    throw new ApiError(
      409,
      "invalid_request",
      `Campaign "${active[0].name}" is scheduled or sending under this topic — pause or finish it first`,
    );
  }

  await db
    .update(campaigns)
    .set({ topicId: null, updatedAt: nowIso() })
    .where(and(eq(campaigns.accountId, account.id), eq(campaigns.topicId, topic.id)));
  await db.delete(topicSubscriptions).where(eq(topicSubscriptions.topicId, topic.id));
  await db.delete(topics).where(eq(topics.id, topic.id));
  return apiJson({ id: topic.id, object: "topic", deleted: true });
});
