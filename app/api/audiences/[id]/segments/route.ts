import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { segments, subscribers } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import {
  SegmentFilterSchema,
  safeParseSegmentFilter,
  segmentFilterCondition,
} from "@/lib/segment-filter";

// A generous backstop, well above any real setup.
const MAX_SEGMENTS = 25;

// Live membership count: subscribed contacts matching the filter — the number a
// campaign sent to this segment would target (before suppression).
async function segmentCount(
  db: Awaited<ReturnType<typeof requireAccount>>["db"],
  audienceId: string,
  filterJson: string,
): Promise<number | null> {
  const filter = safeParseSegmentFilter(filterJson);
  if (!filter) return null;
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(subscribers)
    .where(
      and(
        eq(subscribers.audienceId, audienceId),
        eq(subscribers.status, "subscribed"),
        segmentFilterCondition(filter),
      ),
    );
  return Number(count);
}

// GET /api/audiences/[id]/segments — the audience's saved segments with live
// contact counts (segments are dynamic filters; membership is never stored).
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const rows = await db
    .select()
    .from(segments)
    .where(and(eq(segments.accountId, account.id), eq(segments.audienceId, audience.id)))
    .orderBy(asc(segments.createdAt));

  return json({
    segments: await Promise.all(
      rows.map(async (s) => ({
        id: s.id,
        name: s.name,
        filter: safeParseSegmentFilter(s.filterJson),
        count: await segmentCount(db, audience.id, s.filterJson),
        createdAt: s.createdAt,
      })),
    ),
  });
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
