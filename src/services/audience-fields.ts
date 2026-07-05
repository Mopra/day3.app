import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  audienceFields,
  forms,
  subscribers,
  AUDIENCE_FIELD_TYPES,
  type AudienceField,
  type AudienceFieldType,
} from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { FIELD_KEY_RE, isReservedFieldKey, type FormFieldType } from "../lib/form-fields";

// The per-audience custom-field registry (audience_fields). Field VALUES live in
// subscribers.attributes; this service maintains the catalogue of keys so every
// consumer — the Fields tab, the composer's merge-tag menu, the subscriber
// table's columns, and render-time fallbacks — reads one source of truth.
//
// Keys are auto-registered wherever new ones can enter the system (form save,
// CSV import, manual subscriber add/edit), so the registry follows the data. A
// deleted field whose values were kept will therefore reappear if fresh data
// arrives carrying its key — that's intentional "auto-detect" semantics; a purge
// delete removes the stored values too and stays gone.

// Registry cap per audience — a backstop against a pathological CSV with
// hundreds of columns, comfortably above any real personalization setup.
export const MAX_AUDIENCE_FIELDS = 50;

// "phone_number" → "Phone number" — the default label for auto-registered keys.
export function humanizeFieldKey(key: string): string {
  const s = key.replace(/_/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Signup-form input types are presentational (text/email/tel/url/number); the
// registry keeps a smaller advisory set. Only "number" carries over.
export function formFieldTypeToAudienceType(t: FormFieldType): AudienceFieldType {
  return t === "number" ? "number" : "text";
}

export type FieldRegistration = {
  key: string;
  label?: string;
  type?: AudienceFieldType;
};

// Idempotently add any not-yet-catalogued keys to an audience's registry.
// Reserved keys (email/first_name/last_name) and malformed keys are skipped;
// existing rows are never touched (onConflictDoNothing), so a re-run or a
// concurrent import can't duplicate or clobber user edits (label/type/fallback).
export async function registerAudienceFields(
  db: Db,
  accountId: string,
  audienceId: string,
  entries: FieldRegistration[],
): Promise<void> {
  const seen = new Set<string>();
  const clean = entries.filter((e) => {
    const key = e.key.trim().toLowerCase();
    if (!FIELD_KEY_RE.test(key) || isReservedFieldKey(key) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (clean.length === 0) return;

  // Respect the cap: never grow the registry beyond MAX_AUDIENCE_FIELDS. Counted
  // once up front — a concurrent overshoot by a row or two is harmless.
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(audienceFields)
    .where(eq(audienceFields.audienceId, audienceId));
  const headroom = Math.max(0, MAX_AUDIENCE_FIELDS - Number(count));
  if (headroom === 0) return;

  const now = nowIso();
  await db
    .insert(audienceFields)
    .values(
      clean.slice(0, headroom).map((e) => ({
        id: newId("fld"),
        accountId,
        audienceId,
        key: e.key.trim().toLowerCase(),
        label: e.label?.trim() || humanizeFieldKey(e.key),
        type:
          e.type && (AUDIENCE_FIELD_TYPES as readonly string[]).includes(e.type)
            ? e.type
            : ("text" as const),
        createdAt: now,
        updatedAt: now,
      })),
    )
    .onConflictDoNothing();
}

// One-time backfill for audiences that predate the registry: catalogue the keys
// its signup forms declare plus every key already present on its subscribers.
// Runs only when the registry is empty, so it never resurrects a curated set.
async function seedAudienceFields(db: Db, accountId: string, audienceId: string): Promise<void> {
  const entries: FieldRegistration[] = [];

  // Form-declared fields first — they carry real labels and types.
  const formRows = await db
    .select({ fields: forms.fields })
    .from(forms)
    .where(and(eq(forms.accountId, accountId), eq(forms.audienceId, audienceId)));
  for (const row of formRows) {
    for (const f of row.fields ?? []) {
      entries.push({ key: f.key, label: f.label, type: formFieldTypeToAudienceType(f.type) });
    }
  }

  // Then every attribute key already stored on this audience's subscribers
  // (CSV imports, manual edits) — these only have a key to go on.
  const keyRows = await db
    .selectDistinct({ key: sql<string>`jsonb_object_keys(${subscribers.attributes})` })
    .from(subscribers)
    .where(and(eq(subscribers.audienceId, audienceId), isNotNull(subscribers.attributes)));
  for (const row of keyRows) entries.push({ key: row.key });

  if (entries.length > 0) await registerAudienceFields(db, accountId, audienceId, entries);
}

// The audience's registry, oldest-first (stable order for table columns and the
// merge-tag menu). Seeds from existing data on first read so accounts that
// predate the registry don't start from an empty page.
export async function listAudienceFields(
  db: Db,
  accountId: string,
  audienceId: string,
): Promise<AudienceField[]> {
  const select = () =>
    db
      .select()
      .from(audienceFields)
      .where(eq(audienceFields.audienceId, audienceId))
      .orderBy(asc(audienceFields.createdAt), asc(audienceFields.key));

  const rows = await select();
  if (rows.length > 0) return rows;
  await seedAudienceFields(db, accountId, audienceId);
  return select();
}

// key → fallback for every field that has one — the render-time default merge
// values for a campaign send (see renderCampaignEmail's fieldFallbacks).
export async function getAudienceFieldFallbacks(
  db: Db,
  audienceId: string,
): Promise<Record<string, string>> {
  const rows = await db
    .select({ key: audienceFields.key, fallback: audienceFields.fallback })
    .from(audienceFields)
    .where(and(eq(audienceFields.audienceId, audienceId), isNotNull(audienceFields.fallback)));
  const out: Record<string, string> = {};
  for (const row of rows) {
    const fb = (row.fallback ?? "").trim();
    if (fb) out[row.key] = fb;
  }
  return out;
}
