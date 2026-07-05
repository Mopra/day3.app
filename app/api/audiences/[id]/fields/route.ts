import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { audienceFields, AUDIENCE_FIELD_TYPES } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { FIELD_KEY_RE, isReservedFieldKey, slugifyFieldKey } from "@/lib/form-fields";
import { listAudienceFields, MAX_AUDIENCE_FIELDS } from "@/services/audience-fields";

// GET /api/audiences/[id]/fields — the audience's custom-field registry: every
// field its subscribers can carry, whatever the origin (signup form, CSV import,
// manual edit, or created here). Powers the Fields tab, the subscriber table's
// columns, and the composer's {{merge_tag}} insert menu. Reserved keys
// (email/first_name/last_name) never appear — those are built-in tags. Seeds
// itself from existing forms + subscriber data on first read.
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const fields = await listAudienceFields(db, account.id, audience.id);
  return json({
    fields: fields.map((f) => ({
      id: f.id,
      key: f.key,
      label: f.label,
      type: f.type,
      fallback: f.fallback,
      createdAt: f.createdAt,
    })),
  });
});

const CreateFieldSchema = z.object({
  label: z.string().trim().min(1).max(60),
  // Optional explicit key; derived from the label when omitted.
  key: z.string().trim().max(40).optional(),
  type: z.enum(AUDIENCE_FIELD_TYPES).optional(),
  fallback: z.string().trim().max(500).optional().or(z.literal("")),
});

// POST /api/audiences/[id]/fields — create a field by hand (fields also
// auto-register when new keys arrive via forms, CSV imports, or subscriber
// edits). The key is the {{merge_tag}} and the attributes key, so it must be
// merge-tag-safe and unique within the audience.
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const input = await parseJson(req, CreateFieldSchema);
  const key = slugifyFieldKey(input.key?.trim() || input.label);
  if (!key || !FIELD_KEY_RE.test(key)) {
    throw new HttpError(400, "Field keys use lowercase letters, numbers, and underscores");
  }
  if (isReservedFieldKey(key)) {
    throw new HttpError(400, `"${key}" is built in — it's already available as a merge tag`);
  }

  const existing = await db
    .select({ id: audienceFields.id })
    .from(audienceFields)
    .where(eq(audienceFields.audienceId, audience.id));
  if (existing.length >= MAX_AUDIENCE_FIELDS) {
    throw new HttpError(400, `An audience can have up to ${MAX_AUDIENCE_FIELDS} fields`);
  }

  const now = nowIso();
  const inserted = await db
    .insert(audienceFields)
    .values({
      id: newId("fld"),
      accountId: account.id,
      audienceId: audience.id,
      key,
      label: input.label,
      type: input.type ?? "text",
      fallback: input.fallback?.trim() || null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning();

  if (inserted.length === 0) {
    throw new HttpError(409, `A field with the key "${key}" already exists`);
  }
  return json({ field: inserted[0] }, 201);
});
