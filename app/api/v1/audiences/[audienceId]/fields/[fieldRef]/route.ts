import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { requireAudienceV1, requireFieldV1 } from "@/api/v1/finders";
import { serializeField } from "@/api/v1/serialize";
import { audienceFields, AUDIENCE_FIELD_TYPES } from "@/db/schema";
import { nowIso } from "@/lib/ids";

// {fieldRef} is a fld_… id or the field's key.
type Params = { params: Promise<{ audienceId: string; fieldRef: string }> };

// GET /api/v1/audiences/{id}/fields/{id_or_key}
export const GET = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { audienceId, fieldRef } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const field = await requireFieldV1(db, account.id, audience.id, fieldRef);
  return apiJson(serializeField(field));
});

const PatchFieldSchema = z
  .object({
    key: z.string().optional(),
    label: z.string().trim().min(1).max(60).optional(),
    type: z.enum(AUDIENCE_FIELD_TYPES).optional(),
    // null (or "") clears the fallback.
    fallback: z.string().trim().max(500).nullable().optional(),
  })
  .strict();

// PATCH /api/v1/audiences/{id}/fields/{id_or_key} — label/type/fallback only.
// The key is immutable: it is both the {{merge_tag}} and the stored attributes
// key, so renaming it would orphan every stored value.
export const PATCH = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { audienceId, fieldRef } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const field = await requireFieldV1(db, account.id, audience.id, fieldRef);
  const body = await readJson(req, PatchFieldSchema);

  if (body.key !== undefined && body.key !== field.key) {
    throw new ApiError(
      422,
      "immutable_field",
      "A field's key is immutable — create a new field and migrate values instead",
      { param: "key" },
    );
  }

  const set: Partial<typeof audienceFields.$inferInsert> = { updatedAt: nowIso() };
  if (body.label !== undefined) set.label = body.label;
  if (body.type !== undefined) set.type = body.type;
  if (body.fallback !== undefined) set.fallback = body.fallback || null;

  const [updated] = await db
    .update(audienceFields)
    .set(set)
    .where(eq(audienceFields.id, field.id))
    .returning();
  return apiJson(serializeField(updated));
});

// DELETE /api/v1/audiences/{id}/fields/{id_or_key} — removes the registry row
// only; stored values on contacts are untouched (a later write carrying the
// key re-registers it — auto-detect semantics).
export const DELETE = apiRoute<Params>(async (_req, { db, account }, { params }) => {
  const { audienceId, fieldRef } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const field = await requireFieldV1(db, account.id, audience.id, fieldRef);
  await db.delete(audienceFields).where(eq(audienceFields.id, field.id));
  return apiJson({ id: field.id, object: "field", deleted: true });
});
