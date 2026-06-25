// Custom signup-form fields. A form always collects `email`; on top of that it
// carries an ordered list of these field definitions. A field's `key` does triple
// duty: it is the form input `name`, the subscriber attribute key, and the
// {{merge_tag}} used to personalize campaigns.
//
// Two keys are RESERVED and map to dedicated `subscribers` columns rather than the
// JSON attribute bag: `first_name` and `last_name` (and `email`, which is always
// implicit and never appears in a form's field list). Every other key is stored in
// `subscribers.attributes` — a free-form {key: value} JSON map — and is freely
// personalizable in campaigns.

export const FORM_FIELD_TYPES = ["text", "email", "tel", "url", "number"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export type FormField = {
  // Stable, merge-tag-safe identifier. Lowercase [a-z0-9_]. Used as the input
  // name, the attribute key, and the {{merge_tag}}.
  key: string;
  // Human label shown above the input on the public form.
  label: string;
  type: FormFieldType;
  required: boolean;
};

// Keys that live in dedicated subscriber columns, not the attributes bag. `email`
// is always collected and never part of a form's editable field list.
export const RESERVED_FIELD_KEYS = ["email", "first_name", "last_name"] as const;

export function isReservedFieldKey(key: string): boolean {
  return (RESERVED_FIELD_KEYS as readonly string[]).includes(key);
}

// Derive a stable, merge-tag-safe key from a human label:
// "Phone number" → "phone_number", "Company / org" → "company_org".
export function slugifyFieldKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

const KEY_RE = /^[a-z][a-z0-9_]*$/;
const MAX_FIELDS = 20;
const MAX_VALUE_LEN = 500;
const MAX_NAME_LEN = 100;

// Validate + normalize a raw field list (from the API or a stored row). Drops
// malformed entries and anything with a duplicate or empty key, and caps the
// count. Returns a clean list safe to persist and render. Pure — no I/O.
export function normalizeFields(input: unknown): FormField[] {
  if (!Array.isArray(input)) return [];
  const out: FormField[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    const key = typeof r.key === "string" ? r.key.trim().toLowerCase() : "";
    const label = typeof r.label === "string" ? r.label.trim().slice(0, 60) : "";
    const type = (FORM_FIELD_TYPES as readonly string[]).includes(r.type as string)
      ? (r.type as FormFieldType)
      : "text";
    const required = r.required === true;
    if (!key || !label || !KEY_RE.test(key) || key === "email" || key === "_hp") continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, label, type, required });
    if (out.length >= MAX_FIELDS) break;
  }
  return out;
}

// Clean a raw attributes map (from a manual add/edit): drop blank keys/values,
// lowercase + slug the keys so they stay merge-tag-safe, trim and cap values.
// Returns null when nothing usable remains.
export function normalizeAttributes(
  input: Record<string, string> | null | undefined,
): Record<string, string> | null {
  if (!input) return null;
  const out: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = slugifyFieldKey(String(rawKey));
    const value = String(rawValue ?? "").trim().slice(0, MAX_VALUE_LEN);
    if (!key || !value || isReservedFieldKey(key)) continue;
    out[key] = value;
  }
  return Object.keys(out).length > 0 ? out : null;
}

// Split a flat submitted value map (from the public form / CSV) into the reserved
// column values and the custom attribute bag, honouring a form's declared fields.
// Keys not declared on the form are ignored, so a crafted POST can't write
// arbitrary attributes. `email` is handled by the caller (it is always required).
export function splitSubmittedFields(
  fields: FormField[],
  values: Record<string, string>,
): {
  firstName: string | null;
  lastName: string | null;
  attributes: Record<string, string> | null;
} {
  let firstName: string | null = null;
  let lastName: string | null = null;
  const attributes: Record<string, string> = {};
  for (const f of fields) {
    const value = (values[f.key] ?? "").trim();
    if (!value) continue;
    if (f.key === "first_name") firstName = value.slice(0, MAX_NAME_LEN);
    else if (f.key === "last_name") lastName = value.slice(0, MAX_NAME_LEN);
    else attributes[f.key] = value.slice(0, MAX_VALUE_LEN);
  }
  return {
    firstName,
    lastName,
    attributes: Object.keys(attributes).length > 0 ? attributes : null,
  };
}
