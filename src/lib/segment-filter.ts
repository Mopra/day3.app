import { and, or, sql, type SQL } from "drizzle-orm";
import { z } from "zod";
import { subscribers } from "../db/schema";
import { FIELD_KEY_RE } from "./form-fields";

// The saved-segment filter model: match all/any of up to MAX_CONDITIONS
// conditions over a subscriber's built-in fields (email, first_name, last_name)
// and custom attribute keys. Evaluated live as SQL over `subscribers` — segments
// are dynamic, never materialized.
//
// Values are compared as strings (attributes are a string bag); greater_than /
// less_than compare numerically and simply don't match rows whose stored value
// isn't numeric. A missing attribute is treated as "" — so `plan not_equals pro`
// includes subscribers with no plan at all, which is what a human means by it.

export const SEGMENT_OPS = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "is_set",
  "is_not_set",
  "greater_than",
  "less_than",
] as const;
export type SegmentOp = (typeof SEGMENT_OPS)[number];

// Ops that take no value input.
export const VALUELESS_OPS: readonly SegmentOp[] = ["is_set", "is_not_set"];
// Ops that require a numeric value.
export const NUMERIC_OPS: readonly SegmentOp[] = ["greater_than", "less_than"];

export type SegmentCondition = {
  // A built-in subscriber field or a custom attribute key.
  field: string;
  op: SegmentOp;
  value?: string;
};

export type SegmentFilter = {
  match: "all" | "any";
  conditions: SegmentCondition[];
};

export const MAX_CONDITIONS = 10;

// Built-in fields live in dedicated subscriber columns; anything else is looked
// up in the attributes bag.
const BUILTIN_FIELDS = ["email", "first_name", "last_name"] as const;

const NUMERIC_VALUE_RE = /^-?\d+(\.\d+)?$/;

export const SegmentConditionSchema = z
  .object({
    field: z.string().trim().toLowerCase().regex(FIELD_KEY_RE).max(40),
    op: z.enum(SEGMENT_OPS),
    value: z.string().trim().max(500).optional(),
  })
  .refine((c) => (VALUELESS_OPS.includes(c.op) ? true : !!c.value), {
    message: "This condition needs a value",
  })
  .refine(
    (c) => (NUMERIC_OPS.includes(c.op) ? NUMERIC_VALUE_RE.test(c.value ?? "") : true),
    { message: "Greater/less than needs a number" },
  );

export const SegmentFilterSchema = z.object({
  match: z.enum(["all", "any"]),
  conditions: z.array(SegmentConditionSchema).min(1).max(MAX_CONDITIONS),
});

// Parse a stored filter_json back into a validated filter. Null on any mismatch
// (defensive: a segment with a corrupt filter must never silently match everyone
// — callers treat null as an error, not as "no filter").
export function safeParseSegmentFilter(json: string): SegmentFilter | null {
  try {
    const parsed = SegmentFilterSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// Escape LIKE wildcards in user input so `contains 50%` matches a literal "50%".
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// The subscriber's value for a field, as text with missing coalesced to ''.
function fieldExpr(field: string): SQL {
  if ((BUILTIN_FIELDS as readonly string[]).includes(field)) {
    const column =
      field === "email"
        ? subscribers.email
        : field === "first_name"
          ? subscribers.firstName
          : subscribers.lastName;
    return sql`coalesce(${column}, '')`;
  }
  return sql`coalesce(${subscribers.attributes} ->> ${field}, '')`;
}

function conditionSql(c: SegmentCondition): SQL {
  const expr = fieldExpr(c.field);
  const value = c.value ?? "";
  switch (c.op) {
    case "equals":
      return sql`lower(${expr}) = lower(${value})`;
    case "not_equals":
      return sql`lower(${expr}) <> lower(${value})`;
    case "contains":
      return sql`${expr} ilike ${`%${escapeLike(value)}%`} escape '\\'`;
    case "not_contains":
      return sql`${expr} not ilike ${`%${escapeLike(value)}%`} escape '\\'`;
    case "is_set":
      return sql`${expr} <> ''`;
    case "is_not_set":
      return sql`${expr} = ''`;
    // Numeric compare, guarded so non-numeric stored values simply don't match
    // (instead of erroring the whole query on ::numeric).
    case "greater_than":
      return sql`(${expr} ~ '^-?[0-9]+(\\.[0-9]+)?$' and (${expr})::numeric > ${value}::numeric)`;
    case "less_than":
      return sql`(${expr} ~ '^-?[0-9]+(\\.[0-9]+)?$' and (${expr})::numeric < ${value}::numeric)`;
  }
}

// The filter as a single SQL condition over `subscribers`, to AND onto a query's
// existing scoping (account/audience/status — the caller's responsibility).
export function segmentFilterCondition(filter: SegmentFilter): SQL {
  const parts = filter.conditions.map(conditionSql);
  const combined = filter.match === "any" ? or(...parts) : and(...parts);
  // min(1) on conditions guarantees parts is non-empty, so combined is defined.
  return combined!;
}
