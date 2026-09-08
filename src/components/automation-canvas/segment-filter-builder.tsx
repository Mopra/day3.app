"use client";

import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MAX_CONDITIONS,
  NUMERIC_OPS,
  SEGMENT_OPS,
  VALUELESS_OPS,
  type SegmentCondition,
  type SegmentFilter,
  type SegmentOp,
} from "@/lib/segment-filter-schema";

// The condition builder from the Segments tab, as a controlled component the
// branch inspector can host. Same ops, same labels, same field list, so a
// branch condition reads exactly like a saved segment. The vocabulary comes from
// lib/segment-filter-schema.ts (the database-free half of the filter model), so
// an op added there shows up here without a second list to update.
export const OP_LABELS: Record<SegmentOp, string> = {
  equals: "is",
  not_equals: "is not",
  contains: "contains",
  not_contains: "doesn't contain",
  is_set: "has any value",
  is_not_set: "is empty",
  greater_than: "is greater than",
  less_than: "is less than",
};
const OPS = SEGMENT_OPS.map((value) => ({ value, label: OP_LABELS[value] }));
const VALUELESS = new Set<string>(VALUELESS_OPS);
const NUMERIC = new Set<string>(NUMERIC_OPS);

export const BUILTIN_FIELD_OPTIONS = [
  { key: "email", label: "Email" },
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
];

type Condition = SegmentCondition;
type Op = SegmentOp;

export function SegmentFilterBuilder({
  value,
  onChange,
  fields,
  disabled,
}: {
  value: SegmentFilter;
  onChange: (next: SegmentFilter) => void;
  // The audience's custom fields, appended to the built-in ones. Null while
  // loading; the built-ins are always offered.
  fields: { key: string; label: string }[] | null;
  disabled?: boolean;
}) {
  const fieldOptions = [...BUILTIN_FIELD_OPTIONS, ...(fields ?? [])];
  // A field already on a condition but no longer in the registry still has to be
  // selectable, or the dropdown would show a blank for it.
  const knownKeys = new Set(fieldOptions.map((f) => f.key));
  for (const c of value.conditions) {
    if (!knownKeys.has(c.field)) {
      fieldOptions.push({ key: c.field, label: c.field.replace(/_/g, " ") });
      knownKeys.add(c.field);
    }
  }

  function setCondition(i: number, patch: Partial<Condition>) {
    onChange({
      ...value,
      conditions: value.conditions.map((c, j) => {
        if (j !== i) return c;
        const next = { ...c, ...patch };
        // Valueless ops carry no value; dropping it keeps the saved shape clean.
        if (VALUELESS.has(next.op)) delete next.value;
        return next;
      }),
    });
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>Contacts matching</span>
        <Select
          items={[
            { value: "all", label: "all" },
            { value: "any", label: "any" },
          ]}
          value={value.match}
          disabled={disabled}
          onValueChange={(v) => onChange({ ...value, match: (v as "all" | "any") ?? "all" })}
        >
          <SelectTrigger aria-label="Match" size="sm" className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all</SelectItem>
            <SelectItem value="any">any</SelectItem>
          </SelectContent>
        </Select>
        <span>of these:</span>
      </div>

      <div className="space-y-2">
        {value.conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select
              items={Object.fromEntries(fieldOptions.map((f) => [f.key, f.label]))}
              value={c.field}
              disabled={disabled}
              onValueChange={(v) => v && setCondition(i, { field: v as string })}
            >
              <SelectTrigger aria-label="Field" size="sm" className="min-w-0 flex-1 basis-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fieldOptions.map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              items={Object.fromEntries(OPS.map((o) => [o.value, o.label]))}
              value={c.op}
              disabled={disabled}
              onValueChange={(v) => v && setCondition(i, { op: v as Op })}
            >
              <SelectTrigger aria-label="Operator" size="sm" className="min-w-0 flex-1 basis-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!VALUELESS.has(c.op) && (
              <Input
                aria-label="Value"
                className="h-9 basis-full md:h-7 md:text-[0.8rem]"
                placeholder={NUMERIC.has(c.op) ? "e.g. 10" : "value"}
                inputMode={NUMERIC.has(c.op) ? "decimal" : undefined}
                value={c.value ?? ""}
                disabled={disabled}
                onChange={(e) => setCondition(i, { value: e.target.value })}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() =>
                onChange({ ...value, conditions: value.conditions.filter((_, j) => j !== i) })
              }
              disabled={disabled || value.conditions.length === 1}
              aria-label="Remove condition"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>

      {value.conditions.length < MAX_CONDITIONS && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            onChange({
              ...value,
              conditions: [...value.conditions, { field: "email", op: "contains", value: "" }],
            })
          }
        >
          <Plus className="size-3.5" />
          Add condition
        </Button>
      )}
    </div>
  );
}
