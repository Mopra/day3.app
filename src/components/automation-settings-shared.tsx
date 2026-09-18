"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  BUILTIN_FIELD_OPTIONS,
  OP_LABELS,
} from "@/components/automation-canvas/segment-filter-builder";
import { useApi } from "@/lib/api";
import {
  MAX_CONDITIONS,
  NUMERIC_OPS,
  NUMERIC_VALUE_RE,
  SEGMENT_OPS,
  VALUELESS_OPS,
} from "@/lib/segment-filter-schema";
import { cn } from "@/lib/utils";
import type {
  AutomationDetail,
  AutomationReentryMode,
  AutomationSettingsInput,
} from "@/lib/automation-types";
import type { AudienceField, SegmentFilter } from "@/lib/types";

// The pieces the two settings surfaces share. "Who enters, and whether they come
// back" lives on the trigger node in the canvas inspector; what applies to the
// whole flow lives on the Settings tab. Both write the same automation row
// through the same debounced PATCH, so the plumbing, the filter vocabulary and
// the form furniture sit here rather than being copied into each.

// How long a text field must sit unchanged before we save it. Selects and
// checkboxes save at once; there is nothing to wait for.
export const TEXT_DEBOUNCE_MS = 700;

// Sentinel for "no form narrowing" in the form select; an empty string is not a
// value Base UI's Select will hold.
export const ANY_FORM = "__any__";

// The filter vocabulary comes from the database-free half of the segment model
// and the labels from the canvas's builder, so every condition editor in the app
// agrees about what an op is called.
const OPS = SEGMENT_OPS.map((value) => ({ value, label: OP_LABELS[value] }));
const VALUELESS = new Set<string>(VALUELESS_OPS);
const NUMERIC = new Set<string>(NUMERIC_OPS);
const BUILTIN_FIELDS = BUILTIN_FIELD_OPTIONS;

export type DraftCondition = { field: string; op: string; value: string };
export type FilterDraft = { match: "all" | "any"; conditions: DraftCondition[] };

const NEW_CONDITION: DraftCondition = { field: "email", op: "contains", value: "" };
export const EMPTY_FILTER: FilterDraft = { match: "all", conditions: [NEW_CONDITION] };

export const REENTRY_OPTIONS: { value: AutomationReentryMode; title: string; hint: string }[] = [
  {
    value: "once",
    title: "Once",
    hint: "Each person goes through one time, ever. A re-import can't send the welcome twice.",
  },
  {
    value: "once_at_a_time",
    title: "Once at a time",
    hint: "They can go through again after finishing, but never twice at the same time.",
  },
  {
    value: "always",
    title: "Every time",
    hint: "Every trigger starts a fresh run, even mid-flight. For events that recur, like a trial ending.",
  },
];

export function toDraft(filter: SegmentFilter): FilterDraft {
  return {
    match: filter.match,
    conditions: filter.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value ?? "" })),
  };
}

// A filter the server would accept, or null while it is incomplete (a blank value
// on an op that needs one, a non-number on a numeric op). Only complete filters
// save; a half-typed condition is a legitimate state to sit in.
export function completeFilter(filter: {
  match: "all" | "any";
  conditions: { field: string; op: string; value?: string | null }[];
}): SegmentFilter | null {
  const conditions = filter.conditions.map((c) => ({
    field: c.field,
    op: c.op as SegmentFilter["conditions"][number]["op"],
    value: VALUELESS.has(c.op) ? undefined : (c.value ?? "").trim(),
  }));
  for (const c of conditions) {
    if (!VALUELESS.has(c.op) && !c.value) return null;
    if (NUMERIC.has(c.op) && !NUMERIC_VALUE_RE.test(c.value ?? "")) return null;
  }
  return { match: filter.match, conditions };
}

export function fromDraft(draft: FilterDraft): SegmentFilter | null {
  return completeFilter(draft);
}

/* ────────────────────────── autosave plumbing ────────────────────────── */

export type SettingsSaveStatus = "pending" | "saving" | "saved" | "error";

// Every settings field autosaves the way the composer does: quietly, a moment
// after the last keystroke, with a toast only when the save fails. Edits
// accumulate between keystrokes and go out as one PATCH.
export function useAutomationSettingsSave(
  automationId: string,
  onSaved: (detail: AutomationDetail) => void,
  onStatus?: (status: SettingsSaveStatus) => void,
) {
  const api = useApi();
  // Held in refs so a fast typist doesn't re-arm effects on every character.
  const pending = useRef<AutomationSettingsInput>({});
  const inflight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const idRef = useRef(automationId);
  idRef.current = automationId;

  const flush = useCallback(
    async function flush() {
      if (inflight.current) {
        // Let the current request land first; its response is the base the next
        // one should merge onto server-side.
        timer.current = setTimeout(() => void flush(), 150);
        return;
      }
      const body = pending.current;
      if (Object.keys(body).length === 0) return;
      pending.current = {};
      inflight.current = true;
      onStatusRef.current?.("saving");
      try {
        const detail = await api.patch<AutomationDetail>(`/api/automations/${idRef.current}`, body);
        onSavedRef.current(detail);
        onStatusRef.current?.("saved");
      } catch (err) {
        // The local value stays so nothing the user typed vanishes; the next edit
        // to that field retries. Not re-queued automatically: a rejected value
        // would otherwise toast on every later save of any other field.
        onStatusRef.current?.("error");
        toast.error(err instanceof Error ? err.message : "Couldn't save the automation settings");
      } finally {
        inflight.current = false;
        if (Object.keys(pending.current).length > 0) void flush();
      }
    },
    [api],
  );

  const queueSave = useCallback(
    (patch: AutomationSettingsInput, delayMs = 0) => {
      pending.current = { ...pending.current, ...patch };
      if (timer.current) clearTimeout(timer.current);
      onStatusRef.current?.("pending");
      timer.current = setTimeout(() => void flush(), delayMs);
    },
    [flush],
  );

  // True while local state is newer than the last server response, so a resync
  // effect knows not to overwrite what the user just typed.
  const isBusy = useCallback(() => inflight.current || Object.keys(pending.current).length > 0, []);

  // Leaving the page mid-debounce must not lose the last edit. Best-effort: the
  // response has nowhere to go, so it is fired and forgotten.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      const body = pending.current;
      pending.current = {};
      if (Object.keys(body).length > 0) {
        void api.patch(`/api/automations/${idRef.current}`, body).catch(() => {});
      }
    };
  }, [api]);

  return { queueSave, isBusy };
}

// The audience's custom-field registry for the condition builders. Read once, and
// only once a filter is actually on; most automations never open one.
export function useAudienceFields(audienceId: string, enabled: boolean): AudienceField[] | null {
  const api = useApi();
  const [fields, setFields] = useState<AudienceField[] | null>(null);
  useEffect(() => {
    if (!enabled || fields !== null) return;
    let live = true;
    api
      .get<{ fields: AudienceField[] }>(`/api/audiences/${audienceId}/fields`)
      .then((res) => live && setFields(res.fields))
      .catch(() => live && setFields([]));
    return () => {
      live = false;
    };
  }, [api, enabled, fields, audienceId]);
  return fields;
}

// The live "N match right now" count under a condition editor (design doc §8).
// Null while the filter is incomplete or the count is still on its way.
export function useFilterMatchCount(
  audienceId: string,
  filter: SegmentFilter | null,
): number | null {
  const api = useApi();
  const [count, setCount] = useState<number | null>(null);
  const filterJson = JSON.stringify(filter);
  useEffect(() => {
    if (!filter) {
      setCount(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .post<{ count: number }>(`/api/audiences/${audienceId}/segments/preview`, { filter })
        .then((res) => live && setCount(res.count))
        .catch(() => live && setCount(null));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // Keyed on the serialized filter so retyping the same value doesn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterJson, audienceId]);
  return count;
}

// The sentence under a condition editor, shared so "412 people qualify" reads the
// same wherever a filter is edited.
export function matchCountLine(
  filter: SegmentFilter | null,
  count: number | null,
  subject: string,
): string {
  if (filter === null) {
    return "Fill in every condition to save the filter and see how many people match.";
  }
  if (count === null) return "Counting…";
  return `${count.toLocaleString()} ${count === 1 ? "person" : "people"} ${subject} right now.`;
}

/* ─────────────────────────── building blocks ─────────────────────────── */

export function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3 py-5 first:pt-0 last:pb-0">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="text-sm leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

export function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

export function Hint({ children, tone }: { children: ReactNode; tone?: "warn" }) {
  return (
    <p
      className={cn(
        "text-xs leading-relaxed",
        tone === "warn" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

// A native checkbox in the app's usual clothes (see the forms dialog). The label
// carries the whole row so the hit area is the text, not a 16px square.
export function Toggle({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2.5 text-sm">
      <input
        id={id}
        type="checkbox"
        className="size-4 accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="font-medium">{label}</span>
    </label>
  );
}

// One option of a radio set, laid out as a card so the explanation sits under
// its title instead of trailing off the end of a line. The native input does the
// keyboard work; the border only says which one is chosen.
export function ChoiceCard({
  name,
  checked,
  onSelect,
  title,
  hint,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors",
        checked ? "border-foreground/60 bg-muted/50" : "border-border hover:bg-muted/30",
      )}
    >
      <input
        type="radio"
        name={name}
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={checked}
        onChange={onSelect}
      />
      <span className="min-w-0">
        <span className="block font-medium leading-snug">{title}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

// The Segments tab's condition builder, over the same model, with the same live
// count. Kept here because the tab's editor is not yet a shared component; when
// it becomes one, both should use it. The canvas inspector is too narrow for this
// layout and uses SegmentFilterBuilder instead, over the same vocabulary.
export function FilterEditor({
  idPrefix,
  audienceId,
  draft,
  fields,
  onChange,
  subject,
}: {
  idPrefix: string;
  audienceId: string;
  draft: FilterDraft;
  fields: AudienceField[] | null;
  onChange: (draft: FilterDraft) => void;
  // Verb for the count line: "412 people qualify" vs "12 people would leave".
  subject: string;
}) {
  const fieldOptions = useMemo(
    () => [...BUILTIN_FIELDS, ...(fields ?? []).map((f) => ({ key: f.key, label: f.label }))],
    [fields],
  );
  const filter = useMemo(() => fromDraft(draft), [draft]);
  const preview = useFilterMatchCount(audienceId, filter);

  function setCondition(i: number, patch: Partial<DraftCondition>) {
    onChange({
      ...draft,
      conditions: draft.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    });
  }

  return (
    // No indent of its own: the settings page puts this inside the card whose
    // switch turned it on, which already sets it apart from what surrounds it.
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>People matching</span>
        <Select
          items={{ all: "all", any: "any" }}
          value={draft.match}
          onValueChange={(v) => onChange({ ...draft, match: (v as "all" | "any") ?? "all" })}
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
        {draft.conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select
              items={Object.fromEntries(fieldOptions.map((f) => [f.key, f.label]))}
              value={c.field}
              onValueChange={(v) => v && setCondition(i, { field: v as string })}
            >
              <SelectTrigger
                aria-label="Field"
                className="flex-1 basis-32 sm:w-36 sm:flex-none sm:shrink-0"
              >
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
              onValueChange={(v) => v && setCondition(i, { op: v as string })}
            >
              <SelectTrigger
                aria-label="Operator"
                className="flex-1 basis-32 sm:w-40 sm:flex-none sm:shrink-0"
              >
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
                id={`${idPrefix}-value-${i}`}
                className="flex-1 basis-40"
                placeholder={NUMERIC.has(c.op) ? "e.g. 10" : "value"}
                inputMode={NUMERIC.has(c.op) ? "decimal" : undefined}
                value={c.value}
                onChange={(e) => setCondition(i, { value: e.target.value })}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() =>
                onChange({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })
              }
              disabled={draft.conditions.length === 1}
              aria-label="Remove condition"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>

      {draft.conditions.length < MAX_CONDITIONS && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange({ ...draft, conditions: [...draft.conditions, NEW_CONDITION] })}
        >
          <Plus className="size-3.5" /> Add condition
        </Button>
      )}

      <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
        {matchCountLine(filter, preview, subject)}
      </p>
    </div>
  );
}
