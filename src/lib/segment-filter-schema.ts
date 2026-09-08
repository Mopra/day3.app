import { z } from "zod";
import { FIELD_KEY_RE } from "./form-fields";

// The saved-segment filter model, as pure data: the ops, the Zod schemas and the
// parse helper, with no database in sight. lib/segment-filter.ts re-exports all of
// this and adds the SQL compiler on top. Client code (the automation canvas, the
// branch inspector, the settings panel) imports from here so the browser bundle
// does not carry drizzle-orm and the whole db/schema along for a Zod object.
//
// Values are compared as strings (attributes are a string bag); greater_than /
// less_than compare numerically and simply don't match rows whose stored value
// isn't numeric. A missing attribute is treated as "", so `plan not_equals pro`
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
export const BUILTIN_FIELDS = ["email", "first_name", "last_name"] as const;

export const NUMERIC_VALUE_RE = /^-?\d+(\.\d+)?$/;

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
// (defensive: a segment with a corrupt filter must never silently match everyone;
// callers treat null as an error, not as "no filter").
export function safeParseSegmentFilter(json: string): SegmentFilter | null {
  try {
    const parsed = SegmentFilterSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
