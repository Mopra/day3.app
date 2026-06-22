import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience, findForm } from "@/api/finders";
import { forms, sendingDomains } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { ensureAccountSlug, uniqueFormSlug } from "@/lib/slug";
import { buildFormInstall } from "@/services/form-install";

async function accountHasVerifiedDomain(
  db: Awaited<ReturnType<typeof requireAccount>>["db"],
  accountId: string,
): Promise<boolean> {
  const rows = await db
    .select()
    .from(sendingDomains)
    .where(eq(sendingDomains.accountId, accountId));
  return rows.some(
    (d) => d.fromEmail && (d.verificationStatus === "verified" || d.adminOverrideVerified),
  );
}

// GET /api/forms/[id] — the form plus ready-to-paste install assets and whether
// the account can actually send confirmation emails (double opt-in needs a
// verified sending domain).
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const form = await findForm(db, account.id, id);
  if (!form) throw new HttpError(404, "Not found");

  const accountSlug = await ensureAccountSlug(db, account);
  const install = buildFormInstall(form, accountSlug);
  const hasVerifiedDomain = await accountHasVerifiedDomain(db, account.id);

  return json({ form, install, hasVerifiedDomain });
});

const UpdateFormSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  slug: z.string().trim().min(1).max(48).optional(),
  audienceId: z.string().trim().min(1).optional(),
  status: z.enum(["active", "disabled"]).optional(),
  doubleOptIn: z.boolean().optional(),
  collectName: z.boolean().optional(),
  headline: z.string().trim().max(140).optional().or(z.literal("")),
  description: z.string().trim().max(500).optional().or(z.literal("")),
  buttonLabel: z.string().trim().min(1).max(40).optional(),
  successMessage: z.string().trim().max(300).optional().or(z.literal("")),
  redirectUrl: z.string().trim().url().max(2000).optional().or(z.literal("")),
  accentColor: z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{3,8}$/)
    .optional()
    .or(z.literal("")),
});

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const form = await findForm(db, account.id, id);
  if (!form) throw new HttpError(404, "Not found");

  const input = await parseJson(req, UpdateFormSchema);
  const set: Partial<typeof forms.$inferInsert> = { updatedAt: nowIso() };

  if (input.audienceId && input.audienceId !== form.audienceId) {
    const audience = await findAudience(db, account.id, input.audienceId);
    if (!audience) throw new HttpError(400, "Pick an audience that belongs to your account");
    set.audienceId = audience.id;
  }
  if (input.slug && input.slug !== form.slug) {
    set.slug = await uniqueFormSlug(db, account.id, input.slug, form.id);
  }
  if (input.name !== undefined) set.name = input.name;
  if (input.status !== undefined) set.status = input.status;
  if (input.doubleOptIn !== undefined) set.doubleOptIn = input.doubleOptIn;
  if (input.collectName !== undefined) set.collectName = input.collectName;
  if (input.headline !== undefined) set.headline = input.headline || null;
  if (input.description !== undefined) set.description = input.description || null;
  if (input.buttonLabel !== undefined) set.buttonLabel = input.buttonLabel;
  if (input.successMessage !== undefined) set.successMessage = input.successMessage || null;
  if (input.redirectUrl !== undefined) set.redirectUrl = input.redirectUrl || null;
  if (input.accentColor !== undefined) set.accentColor = input.accentColor || null;

  await db.update(forms).set(set).where(and(eq(forms.id, form.id), eq(forms.accountId, account.id)));

  const updated = await findForm(db, account.id, form.id);
  return json({ form: updated });
});

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const form = await findForm(db, account.id, id);
  if (!form) throw new HttpError(404, "Not found");
  await db.delete(forms).where(and(eq(forms.id, form.id), eq(forms.accountId, account.id)));
  return json({ ok: true });
});
