import { and, desc, eq } from "drizzle-orm";
import { apiRoute } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { requireAudienceV1, requireSegmentV1 } from "@/api/v1/finders";
import { cursorCondition, pageResponse, parsePageQuery } from "@/api/v1/pagination";
import { serializeContact } from "@/api/v1/serialize";
import { subscribers } from "@/db/schema";
import { safeParseSegmentFilter, segmentFilterCondition } from "@/lib/segment-filter";

type Params = { params: Promise<{ audienceId: string; segmentId: string }> };

// GET /api/v1/audiences/{id}/segments/{segmentId}/contacts — the segment's
// CURRENT live matches (segments are dynamic; nothing is materialized).
export const GET = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { audienceId, segmentId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const segment = await requireSegmentV1(db, account.id, audience.id, segmentId);
  const { limit, after } = parsePageQuery(req);

  const filter = safeParseSegmentFilter(segment.filterJson);
  if (!filter) throw new ApiError(400, "invalid_filter", "This segment's filter is invalid");

  const filters = [eq(subscribers.audienceId, audience.id), segmentFilterCondition(filter)];
  if (after) filters.push(cursorCondition(subscribers.createdAt, subscribers.id, after));

  const rows = await db
    .select()
    .from(subscribers)
    .where(and(...filters))
    .orderBy(desc(subscribers.createdAt), desc(subscribers.id))
    .limit(limit + 1);

  return apiJson(pageResponse(rows, limit, (s) => serializeContact(s)));
});
