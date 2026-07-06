import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { apiJson } from "@/api/v1/errors";
import { requireAudienceV1 } from "@/api/v1/finders";
import { withIdempotency } from "@/api/v1/idempotency";
import { cursorCondition, pageResponse, parsePageQuery } from "@/api/v1/pagination";
import { serializeSegment } from "@/api/v1/serialize";
import { segments } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { SegmentFilterSchema } from "@/lib/segment-filter";

type Params = { params: Promise<{ audienceId: string }> };

// GET /api/v1/audiences/{id}/segments
export const GET = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { audienceId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const { limit, after } = parsePageQuery(req);

  const filters = [eq(segments.audienceId, audience.id)];
  if (after) filters.push(cursorCondition(segments.createdAt, segments.id, after));

  const rows = await db
    .select()
    .from(segments)
    .where(and(...filters))
    .orderBy(desc(segments.createdAt), desc(segments.id))
    .limit(limit + 1);

  return apiJson(pageResponse(rows, limit, serializeSegment));
});

const CreateSegmentSchema = z.object({
  name: z.string().trim().min(1).max(80),
  // The public filter contract — SegmentFilterSchema verbatim (match all/any,
  // 1–10 conditions over built-in fields and custom attribute keys).
  filter: SegmentFilterSchema,
});

// POST /api/v1/audiences/{id}/segments — segments are live saved filters;
// membership is evaluated at read/send time, never materialized.
export const POST = apiRoute<Params>(async (req, ctx, { params }) => {
  const { audienceId } = await params;
  const audience = await requireAudienceV1(ctx.db, ctx.account.id, audienceId);
  const body = await readJson(req, CreateSegmentSchema);

  return withIdempotency(ctx, req, `POST /v1/audiences/${audience.id}/segments`, body, async () => {
    const now = nowIso();
    const [created] = await ctx.db
      .insert(segments)
      .values({
        id: newId("seg"),
        accountId: ctx.account.id,
        audienceId: audience.id,
        name: body.name,
        filterJson: JSON.stringify(body.filter),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return apiJson(serializeSegment(created), 201);
  });
});
