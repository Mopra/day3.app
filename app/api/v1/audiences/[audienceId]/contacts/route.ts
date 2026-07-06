import { and, desc, eq } from "drizzle-orm";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { ContactInputSchema, writeContacts } from "@/api/v1/contacts";
import { requireAudienceV1, requireSegmentV1 } from "@/api/v1/finders";
import { withIdempotency } from "@/api/v1/idempotency";
import { cursorCondition, pageResponse, parsePageQuery } from "@/api/v1/pagination";
import { serializeContact } from "@/api/v1/serialize";
import { SUBSCRIBER_STATUSES, subscribers } from "@/db/schema";
import { canonicalizeEmail } from "@/lib/csv";
import { safeParseSegmentFilter, segmentFilterCondition } from "@/lib/segment-filter";

type Params = { params: Promise<{ audienceId: string }> };

// GET /api/v1/audiences/{id}/contacts — cursor list with ?status=, ?email=
// (exact match), ?segment_id= (live segment evaluation).
export const GET = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { audienceId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const { limit, after } = parsePageQuery(req);
  const search = req.nextUrl.searchParams;

  const filters = [eq(subscribers.audienceId, audience.id)];

  const status = search.get("status");
  if (status) {
    if (!(SUBSCRIBER_STATUSES as readonly string[]).includes(status)) {
      throw new ApiError(400, "invalid_request", `Unknown status "${status}"`, { param: "status" });
    }
    filters.push(eq(subscribers.status, status as (typeof SUBSCRIBER_STATUSES)[number]));
  }

  const email = search.get("email");
  if (email) filters.push(eq(subscribers.email, canonicalizeEmail(email)));

  const segmentId = search.get("segment_id");
  if (segmentId) {
    const segment = await requireSegmentV1(db, account.id, audience.id, segmentId);
    const filter = safeParseSegmentFilter(segment.filterJson);
    if (!filter) throw new ApiError(400, "invalid_filter", "This segment's filter is invalid");
    filters.push(segmentFilterCondition(filter));
  }

  if (after) filters.push(cursorCondition(subscribers.createdAt, subscribers.id, after));

  const rows = await db
    .select()
    .from(subscribers)
    .where(and(...filters))
    .orderBy(desc(subscribers.createdAt), desc(subscribers.id))
    .limit(limit + 1);

  return apiJson(pageResponse(rows, limit, (s) => serializeContact(s)));
});

// POST /api/v1/audiences/{id}/contacts[?upsert=true] — create one contact.
export const POST = apiRoute<Params>(async (req, ctx, { params }) => {
  const { audienceId } = await params;
  const audience = await requireAudienceV1(ctx.db, ctx.account.id, audienceId);
  const upsert = req.nextUrl.searchParams.get("upsert") === "true";
  const body = await readJson(req, ContactInputSchema);

  return withIdempotency(ctx, req, `POST /v1/audiences/${audience.id}/contacts`, body, async () => {
    const { results } = await writeContacts(ctx.db, ctx.account, audience.id, [body], { upsert });
    const result = results[0];
    if (result.status === "failed") {
      const status =
        result.code === "contact_already_exists" || result.code === "email_suppressed" ? 409 : 400;
      throw new ApiError(status, result.code, result.message, { param: "email" });
    }
    return apiJson(serializeContact(result.contact), result.status === "created" ? 201 : 200);
  });
});
