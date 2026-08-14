import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { listForms } from "@/api/lists";
import { forms } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { ensureAccountSlug, uniqueFormSlug } from "@/lib/slug";
import { FORM_FIELD_TYPES, isReservedFieldKey, normalizeFields } from "@/lib/form-fields";
import { formFieldTypeToAudienceType, registerAudienceFields } from "@/services/audience-fields";

// GET /api/forms — list this account's signup forms with their audience name.
export const GET = route(async () => {
  const { db, account } = await requireAccount();
  return json({ forms: await listForms(db, account.id) });
});

const CreateFormSchema = z.object({
  name: z.string().trim().min(1).max(120),
  audienceId: z.string().trim().min(1),
  slug: z.string().trim().max(48).optional(),
  doubleOptIn: z.boolean().optional(),
  collectName: z.boolean().optional(),
  fields: z
    .array(
      z.object({
        key: z.string().trim().min(1).max(40),
        label: z.string().trim().min(1).max(60),
        type: z.enum(FORM_FIELD_TYPES),
        required: z.boolean(),
      }),
    )
    .optional(),
  headline: z.string().trim().max(140).optional(),
  description: z.string().trim().max(500).optional(),
  buttonLabel: z.string().trim().max(40).optional(),
  successMessage: z.string().trim().max(300).optional(),
  redirectUrl: z.string().trim().url().max(2000).optional().or(z.literal("")),
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{3,8}$/)
    .optional()
    .or(z.literal("")),
});

// POST /api/forms — create a signup form. The audience must belong to the
// account; the slug is derived (uniquely) from the requested slug or the name.
export const POST = route(async (req) => {
  const { db, account } = await requireAccount();
  const input = await parseJson(req, CreateFormSchema);

  const audience = await findAudience(db, account.id, input.audienceId);
  if (!audience) throw new HttpError(400, "Pick an audience that belongs to your account");

  // Make sure the account has a public slug for pretty URLs.
  await ensureAccountSlug(db, account);

  const slug = await uniqueFormSlug(db, account.id, input.slug || input.name);
  const id = newId("frm");
  const now = nowIso();

  // `fields` is canonical; fall back to the legacy collectName flag (seed a first
  // name field) so older clients still work. collectName is kept in sync.
  const fields = input.fields
    ? normalizeFields(input.fields)
    : input.collectName
      ? normalizeFields([{ key: "first_name", label: "First name", type: "text", required: false }])
      : [];

  // Catalogue the form's custom fields in the audience's field registry so they
  // are merge tags / table columns from day one (idempotent; reserved keys skip).
  const customFields = fields.filter((f) => !isReservedFieldKey(f.key));
  if (customFields.length > 0) {
    await registerAudienceFields(
      db,
      account.id,
      audience.id,
      customFields.map((f) => ({
        key: f.key,
        label: f.label,
        type: formFieldTypeToAudienceType(f.type),
      })),
    );
  }

  await db.insert(forms).values({
    id,
    accountId: account.id,
    audienceId: audience.id,
    slug,
    name: input.name,
    status: "active",
    doubleOptIn: input.doubleOptIn ?? true,
    collectName: fields.some((f) => f.key === "first_name"),
    fields,
    headline: input.headline || null,
    description: input.description || null,
    buttonLabel: input.buttonLabel?.trim() || "Subscribe",
    successMessage: input.successMessage || null,
    redirectUrl: input.redirectUrl || null,
    accentColor: input.accentColor || null,
    createdAt: now,
    updatedAt: now,
  });

  return json({ form: { id, slug } }, 201);
});
