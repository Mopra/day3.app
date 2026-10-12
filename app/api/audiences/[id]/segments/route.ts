import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { listSegmentRows, segmentCount } from "@/api/audience-detail";
import { segments } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { SegmentFilterSchema } from "@/lib/segment-filter";

// A generous backstop, well above any real setup.
const MAX_SEGMENTS = 25;

// GET /api/audiences/[id]/segments: the audience's saved segments with live
// contact counts (segments are dynamic filters; membership is never stored).
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  return json({ segments: await listSegmentRows(db, account.id, audience.id) });
});

const CreateSegmentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  filter: SegmentFilterSchema,
});

// POST /api/audiences/[id]/segments — save a segment.
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const input = await parseJson(req, CreateSegmentSchema);

  const existing = await db
    .select({ id: segments.id })
    .from(segments)
    .where(and(eq(segments.accountId, account.id), eq(segments.audienceId, audience.id)));
  if (existing.length >= MAX_SEGMENTS) {
    throw new HttpError(400, `An audience can have up to ${MAX_SEGMENTS} segments`);
  }

  const now = nowIso();
  const segmentId = newId("seg");
  await db.insert(segments).values({
    id: segmentId,
    accountId: account.id,
    audienceId: audience.id,
    name: input.name,
    filterJson: JSON.stringify(input.filter),
    createdAt: now,
    updatedAt: now,
  });

  return json(
    {
      segment: {
        id: segmentId,
        name: input.name,
        filter: input.filter,
        count: await segmentCount(db, audience.id, JSON.stringify(input.filter)),
        createdAt: now,
      },
    },
    201,
  );
});
