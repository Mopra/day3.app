import { desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { audiences, forms } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { ensureAccountSlug, uniqueFormSlug } from "@/lib/slug";
import { FORM_FIELD_TYPES, normalizeFields } from "@/lib/form-fields";
import { resolveFormDesign } from "@/lib/form-design";

// GET /api/forms — list this account's signup forms with their audience name.
export const GET = route(async () => {
  const { db, account } = await requireAccount();
  const rows = await db
    .select()
    .from(forms)
    .where(eq(forms.accountId, account.id))
    .orderBy(desc(forms.createdAt));

  const audienceIds = [...new Set(rows.map((f) => f.audienceId))];
  const audienceRows =
    audienceIds.length > 0
      ? await db.select().from(audiences).where(inArray(audiences.id, audienceIds))
      : [];
  const audienceName = new Map(audienceRows.map((a) => [a.id, a.name]));

  return json({
    forms: rows.map((f) => ({
      ...f,
      design: resolveFormDesign(f.design),
      audienceName: audienceName.get(f.audienceId) ?? null,
    })),
  });
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
