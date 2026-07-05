import { unstable_cache } from "next/cache";
import { and, eq } from "drizzle-orm";
import { getDb, type Db } from "../db/client";
import { accounts, forms, type Form } from "../db/schema";

export type PublicFormData = {
  form: Form;
  companyName: string;
};

// Cache tag for a single hosted form's public render. Bumped from the form's
// write path (PATCH/DELETE) via revalidateTag so an owner's edit shows up
// immediately despite the render being served from the data cache.
export function publicFormTag(id: string): string {
  return `public-form:${id}`;
}

// One round-trip: join the form to its owning account instead of two sequential
// queries. Used by both public loaders below.
async function queryFormById(db: Db, id: string): Promise<PublicFormData | null> {
  const rows = await db
    .select({ form: forms, companyName: accounts.name })
    .from(forms)
    .leftJoin(accounts, eq(accounts.id, forms.accountId))
    .where(eq(forms.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { form: row.form, companyName: row.companyName ?? "this sender" };
}

// Loads a form for public rendering by its stable id (the embed + hosted
// /f/<id> path — the hot one). Cached in the Next.js data cache and tagged by
// id, so repeat opens skip the DB entirely and edits invalidate on write.
export async function loadPublicFormById(id: string): Promise<PublicFormData | null> {
  const cached = unstable_cache(() => queryFormById(getDb(), id), ["public-form-by-id", id], {
    tags: [publicFormTag(id)],
    // Backstop only — the real freshness comes from revalidateTag on edit.
    revalidate: 3600,
  });
  return cached();
}

// Loads a form by the pretty (account-slug, form-slug) pair used in share URLs.
// The human-facing share link (bios/social), not the embed path, so it stays a
// direct read — always fresh, no cache-key churn when a slug is renamed.
export async function loadPublicFormBySlugs(
  accountSlug: string,
  formSlug: string,
): Promise<PublicFormData | null> {
  const db = getDb();
  const rows = await db
    .select({ form: forms, companyName: accounts.name })
    .from(forms)
    .innerJoin(accounts, eq(accounts.id, forms.accountId))
    .where(and(eq(accounts.slug, accountSlug), eq(forms.slug, formSlug)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { form: row.form, companyName: row.companyName ?? "this sender" };
}
