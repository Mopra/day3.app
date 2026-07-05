import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { campaigns, topics, topicSubscriptions } from "@/db/schema";
import { nowIso } from "@/lib/ids";

type Params = { params: Promise<{ id: string; topicId: string }> };

// Campaign statuses where the send pipeline may still read the topic.
const ACTIVE_STATUSES = [
  "scheduled",
  "pending_review",
  "approved",
  "generating_recipients",
  "sending",
  "paused",
] as const;

async function findTopic(
  db: Awaited<ReturnType<typeof requireAccount>>["db"],
  accountId: string,
  audienceId: string,
  topicId: string,
) {
  return db.query.topics.findFirst({
    where: and(
      eq(topics.id, topicId),
      eq(topics.accountId, accountId),
      eq(topics.audienceId, audienceId),
    ),
  });
}

const UpdateTopicSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(300).optional(),
  // Deliberately NOT editable after creation: flipping opt-out ↔ opt-in would
  // silently invert what every stored subscription row means.
});

// PATCH /api/audiences/[id]/topics/[topicId] — rename / re-describe a topic.
export const PATCH = route<Params>(async (req, { params }) => {
  const { id, topicId } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");
  const topic = await findTopic(db, account.id, audience.id, topicId);
  if (!topic) throw new HttpError(404, "Not found");

  const data = await parseJson(req, UpdateTopicSchema);
  const set: Partial<typeof topics.$inferInsert> = { updatedAt: nowIso() };
  if (data.name !== undefined) set.name = data.name;
  if (data.description !== undefined) set.description = data.description || null;

  const [updated] = await db.update(topics).set(set).where(eq(topics.id, topic.id)).returning();
  return json({ topic: updated });
});

// DELETE /api/audiences/[id]/topics/[topicId]. Blocked while a scheduled or
// in-flight campaign is sent under the topic; otherwise removes the topic, its
// subscription rows, and clears the reference on drafts/finished campaigns
// (they fall back to "no topic" — the full audience, full unsubscribe only).
export const DELETE = route<Params>(async (_req, { params }) => {
  const { id, topicId } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");
  const topic = await findTopic(db, account.id, audience.id, topicId);
  if (!topic) throw new HttpError(404, "Not found");

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
    throw new HttpError(
      409,
      `"${active[0].name}" is scheduled or sending under this topic — pause or finish it first`,
    );
  }

  await db
    .update(campaigns)
    .set({ topicId: null, updatedAt: nowIso() })
    .where(and(eq(campaigns.accountId, account.id), eq(campaigns.topicId, topic.id)));
  await db.delete(topicSubscriptions).where(eq(topicSubscriptions.topicId, topic.id));
  await db.delete(topics).where(eq(topics.id, topic.id));
  return json({ ok: true });
});
