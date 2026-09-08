import { and, or, sql, type SQL } from "drizzle-orm";
import { subscribers } from "../db/schema";
import {
  BUILTIN_FIELDS,
  type SegmentCondition,
  type SegmentFilter,
} from "./segment-filter-schema";

// The saved-segment filter model: match all/any of up to MAX_CONDITIONS
// conditions over a subscriber's built-in fields (email, first_name, last_name)
// and custom attribute keys. Evaluated live as SQL over `subscribers`; segments
// are dynamic, never materialized.
//
// The model itself (ops, Zod schemas, parse helper) lives in
// lib/segment-filter-schema.ts so client code can validate a filter without
// pulling drizzle and the database schema into the browser bundle. It is
// re-exported here so every existing server-side importer keeps one import.
export * from "./segment-filter-schema";

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
// existing scoping (account/audience/status, the caller's responsibility).
export function segmentFilterCondition(filter: SegmentFilter): SQL {
  const parts = filter.conditions.map(conditionSql);
  const combined = filter.match === "any" ? or(...parts) : and(...parts);
  // min(1) on conditions guarantees parts is non-empty, so combined is defined.
  return combined!;
}
