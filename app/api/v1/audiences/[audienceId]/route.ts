import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { apiJson } from "@/api/v1/errors";
import { requireAudienceV1 } from "@/api/v1/finders";
import { serializeAudience } from "@/api/v1/serialize";
import {
  audienceFields,
  audiences,
  segments,
  subscribers,
  topicSubscriptions,
  topics,
} from "@/db/schema";
import { nowIso } from "@/lib/ids";

type Params = { params: Promise<{ audienceId: string }> };

// GET /api/v1/audiences/{id} — includes contact_counts (list omits them).
export const GET = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { audienceId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);

  const counts = await db
    .select({ status: subscribers.status, count: sql<number>`count(*)`.as("count") })
    .from(subscribers)
    .where(eq(subscribers.audienceId, audience.id))
    .groupBy(subscribers.status);

  return apiJson(
    serializeAudience(
      audience,
      Object.fromEntries(counts.map((r) => [r.status, Number(r.count)])),
    ),
  );
});

const UpdateAudienceSchema = z.object({ name: z.string().trim().min(1).max(100) });

// PATCH /api/v1/audiences/{id}
export const PATCH = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { audienceId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const { name } = await readJson(req, UpdateAudienceSchema);
  const [updated] = await db
    .update(audiences)
    .set({ name, updatedAt: nowIso() })
    .where(eq(audiences.id, audience.id))
    .returning();
  return apiJson(serializeAudience(updated));
});

// DELETE /api/v1/audiences/{id} — removes the audience AND everything in it
// (contacts, fields, segments, topics + subscription rows). Irreversible.
export const DELETE = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { audienceId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);

  const audienceTopics = await db
    .select({ id: topics.id })
    .from(topics)
    .where(eq(topics.audienceId, audience.id));
  for (const t of audienceTopics) {
    await db.delete(topicSubscriptions).where(eq(topicSubscriptions.topicId, t.id));
  }
  await db.delete(topics).where(eq(topics.audienceId, audience.id));
  await db.delete(segments).where(eq(segments.audienceId, audience.id));
  await db.delete(audienceFields).where(eq(audienceFields.audienceId, audience.id));
  await db.delete(subscribers).where(eq(subscribers.audienceId, audience.id));
  await db.delete(audiences).where(eq(audiences.id, audience.id));

  return apiJson({ id: audience.id, object: "audience", deleted: true });
});
