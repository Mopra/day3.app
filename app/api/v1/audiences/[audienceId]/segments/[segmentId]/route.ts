import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { apiJson } from "@/api/v1/errors";
import { requireAudienceV1, requireSegmentV1 } from "@/api/v1/finders";
import { serializeSegment } from "@/api/v1/serialize";
import { segments } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { SegmentFilterSchema } from "@/lib/segment-filter";

type Params = { params: Promise<{ audienceId: string; segmentId: string }> };

// GET /api/v1/audiences/{id}/segments/{segmentId}
export const GET = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { audienceId, segmentId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const segment = await requireSegmentV1(db, account.id, audience.id, segmentId);
  return apiJson(serializeSegment(segment));
});

const PatchSegmentSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  filter: SegmentFilterSchema.optional(),
});

// PATCH /api/v1/audiences/{id}/segments/{segmentId}
export const PATCH = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { audienceId, segmentId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const segment = await requireSegmentV1(db, account.id, audience.id, segmentId);
  const body = await readJson(req, PatchSegmentSchema);

  const set: Partial<typeof segments.$inferInsert> = { updatedAt: nowIso() };
  if (body.name !== undefined) set.name = body.name;
  if (body.filter !== undefined) set.filterJson = JSON.stringify(body.filter);

  const [updated] = await db
    .update(segments)
    .set(set)
    .where(eq(segments.id, segment.id))
    .returning();
  return apiJson(serializeSegment(updated));
});

// DELETE /api/v1/audiences/{id}/segments/{segmentId} — removes the saved
// filter only; contacts are untouched.
export const DELETE = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { audienceId, segmentId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const segment = await requireSegmentV1(db, account.id, audience.id, segmentId);
  await db.delete(segments).where(eq(segments.id, segment.id));
  return apiJson({ id: segment.id, object: "segment", deleted: true });
});
