import { and, eq, ne } from "drizzle-orm";
import type { Db } from "@/db/client";
import { accounts, forms } from "@/db/schema";
import { nowIso } from "@/lib/ids";

// First-path-segment names that must never be an account slug, because the public
// forms host (go.day3.app) routes /f/<id> for stable embeds and reserves a few
// internals. An account slug colliding with one of these would shadow that route.
const RESERVED_ACCOUNT_SLUGS = new Set([
  "f",
  "api",
  "hosted",
  "_next",
  "sign-in",
  "sign-up",
  "unsubscribe",
  "admin",
  "go",
  "www",
  "favicon.ico",
  "robots.txt",
]);

const MAX_SLUG_LEN = 48;

/**
 * Normalize arbitrary text into a URL-safe slug: ASCII-folded, lowercased,
 * non-alphanumerics collapsed to single hyphens, trimmed, length-bounded.
 * Returns `fallback` when nothing usable survives (e.g. an all-emoji name).
 */
export function slugify(input: string, fallback = "form"): string {
  const base = input
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LEN)
    .replace(/-+$/g, "");
  return base || fallback;
}

function deReserve(slug: string): string {
  return RESERVED_ACCOUNT_SLUGS.has(slug) ? `${slug}-team` : slug;
}

// Append -2, -3, … until `isFree(candidate)` is true. The (account,slug) /
// global unique indexes are the real guard against a race; this just minimizes
// collisions before the insert.
async function findFreeSlug(
  base: string,
  isFree: (candidate: string) => Promise<boolean>,
): Promise<string> {
  if (await isFree(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base.slice(0, MAX_SLUG_LEN - 5)}-${n}`;
    if (await isFree(candidate)) return candidate;
  }
  // Astronomically unlikely; fall back to a random suffix.
  return `${base.slice(0, MAX_SLUG_LEN - 7)}-${Math.floor(Math.random() * 1e6)}`;
}

/**
 * Resolve (and persist, once) the account's public slug. Generated lazily from
 * the account name the first time a public surface needs it. Idempotent: returns
 * the stored slug if already set. Tolerates a concurrent writer via the unique
 * constraint — on a duplicate-key race we re-read the now-set slug.
 */
export async function ensureAccountSlug(
  db: Db,
  account: { id: string; name: string; slug: string | null },
): Promise<string> {
  if (account.slug) return account.slug;
  const base = deReserve(slugify(account.name, "team"));
  const slug = await findFreeSlug(base, async (candidate) => {
    const hit = await db.query.accounts.findFirst({ where: eq(accounts.slug, candidate) });
    return !hit;
  });
  try {
    await db.update(accounts).set({ slug, updatedAt: nowIso() }).where(eq(accounts.id, account.id));
    return slug;
  } catch {
    // Lost a race (slug taken or this account got a slug concurrently): re-read.
    const fresh = await db.query.accounts.findFirst({ where: eq(accounts.id, account.id) });
    if (fresh?.slug) return fresh.slug;
    throw new Error("failed to assign account slug");
  }
}

/**
 * A unique-within-account form slug derived from `desired` (or the form name).
 * Pass `excludeFormId` when renaming so the form's own current slug doesn't count
 * as a collision.
 */
export async function uniqueFormSlug(
  db: Db,
  accountId: string,
  desired: string,
  excludeFormId?: string,
): Promise<string> {
  const base = slugify(desired, "form");
  return findFreeSlug(base, async (candidate) => {
    const hit = await db.query.forms.findFirst({
      where: excludeFormId
        ? and(
            eq(forms.accountId, accountId),
            eq(forms.slug, candidate),
            ne(forms.id, excludeFormId),
          )
        : and(eq(forms.accountId, accountId), eq(forms.slug, candidate)),
    });
    return !hit;
  });
}
