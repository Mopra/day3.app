import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { accounts, forms, type Form } from "../db/schema";

export type PublicFormData = {
  form: Form;
  companyName: string;
};

// Loads a form for public rendering by its stable id (used for embeds + the
// hosted /f/<id> page). Returns null if the form doesn't exist.
export async function loadPublicFormById(db: Db, id: string): Promise<PublicFormData | null> {
  const form = await db.query.forms.findFirst({ where: eq(forms.id, id) });
  if (!form) return null;
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, form.accountId) });
  return { form, companyName: account?.name ?? "this sender" };
}

// Loads a form by the pretty (account-slug, form-slug) pair used in share URLs.
export async function loadPublicFormBySlugs(
  db: Db,
  accountSlug: string,
  formSlug: string,
): Promise<PublicFormData | null> {
  const account = await db.query.accounts.findFirst({ where: eq(accounts.slug, accountSlug) });
  if (!account) return null;
  const form = await db.query.forms.findFirst({
    where: and(eq(forms.accountId, account.id), eq(forms.slug, formSlug)),
  });
  if (!form) return null;
  return { form, companyName: account.name };
}
