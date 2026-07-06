import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { requireAudienceV1 } from "@/api/v1/finders";
import { withIdempotency } from "@/api/v1/idempotency";
import { serializeField } from "@/api/v1/serialize";
import { audienceFields, AUDIENCE_FIELD_TYPES } from "@/db/schema";
import { FIELD_KEY_RE, isReservedFieldKey } from "@/lib/form-fields";
import { listAudienceFields, registerAudienceFields } from "@/services/audience-fields";

type Params = { params: Promise<{ audienceId: string }> };

// GET /api/v1/audiences/{id}/fields — the full registry, oldest-first. Not
// cursor-paginated: the registry is capped at 50 rows.
export const GET = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { audienceId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const fields = await listAudienceFields(db, account.id, audience.id);
  return apiJson({ data: fields.map(serializeField), has_more: false, next_cursor: null });
});

const CreateFieldSchema = z.object({
  key: z.string().trim().toLowerCase().min(1).max(40),
  label: z.string().trim().min(1).max(60).optional(),
  type: z.enum(AUDIENCE_FIELD_TYPES).optional(),
  fallback: z.string().trim().max(500).optional(),
});

// POST /api/v1/audiences/{id}/fields — declare a field up front (fields also
// auto-register when contacts arrive carrying new attribute keys).
export const POST = apiRoute<Params>(async (req, ctx, { params }) => {
  const { audienceId } = await params;
  const audience = await requireAudienceV1(ctx.db, ctx.account.id, audienceId);
  const body = await readJson(req, CreateFieldSchema);

  if (!FIELD_KEY_RE.test(body.key)) {
    throw new ApiError(
      400,
      "invalid_request",
      "key must start with a letter and contain only a-z, 0-9 and _",
      { param: "key" },
    );
  }
  if (isReservedFieldKey(body.key)) {
    throw new ApiError(
      400,
      "invalid_request",
      `"${body.key}" is a built-in contact field and cannot be a custom field key`,
      { param: "key" },
    );
  }

  return withIdempotency(ctx, req, `POST /v1/audiences/${audience.id}/fields`, body, async () => {
    const existing = await ctx.db.query.audienceFields.findFirst({
      where: and(eq(audienceFields.audienceId, audience.id), eq(audienceFields.key, body.key)),
    });
    if (existing) {
      throw new ApiError(409, "invalid_request", "A field with this key already exists", {
        param: "key",
      });
    }

    await registerAudienceFields(ctx.db, ctx.account.id, audience.id, [
      { key: body.key, label: body.label, type: body.type },
    ]);
    const created = await ctx.db.query.audienceFields.findFirst({
      where: and(eq(audienceFields.audienceId, audience.id), eq(audienceFields.key, body.key)),
    });
    // registerAudienceFields silently skips at the 50-field registry cap.
    if (!created) {
      throw new ApiError(
        403,
        "plan_limit_reached",
        "This audience has reached the 50 custom-field limit",
      );
    }
    if (body.fallback) {
      await ctx.db
        .update(audienceFields)
        .set({ fallback: body.fallback })
        .where(eq(audienceFields.id, created.id));
      created.fallback = body.fallback;
    }
    return apiJson(serializeField(created), 201);
  });
});
