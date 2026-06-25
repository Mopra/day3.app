"use client";

import { ChevronDown, ChevronUp, GripVertical, Plus, Trash2 } from "lucide-react";
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
  type FormField,
  type FormFieldType,
  slugifyFieldKey,
} from "@/lib/form-fields";

// The signup-form field builder. Email is always collected (shown as a locked
// row); on top of it the user adds any fields they like. A field's merge-tag key
// is derived from its label, so non-technical users never touch raw keys — they
// type "Phone number" and we tell them it's usable in emails as {{phone_number}}.

const TYPE_LABELS: Record<FormFieldType, string> = {
  text: "Text",
  email: "Email",
  tel: "Phone",
  url: "URL",
  number: "Number",
};

const TYPE_ITEMS = (Object.keys(TYPE_LABELS) as FormFieldType[]).map((value) => ({
  value,
  label: TYPE_LABELS[value],
}));

// One-click presets. Just convenience — each only prefills a label + type; the
// key is still derived from the label like any other field.
const PRESETS: { label: string; type: FormFieldType }[] = [
  { label: "First name", type: "text" },
  { label: "Last name", type: "text" },
  { label: "Phone", type: "tel" },
  { label: "Company", type: "text" },
];

function mergeTagFor(field: FormField): string {
  const key = field.key || slugifyFieldKey(field.label);
  return key ? `{{${key}}}` : "—";
}

export function FormFieldsEditor({
  fields,
  onChange,
}: {
  fields: FormField[];
  onChange: (next: FormField[]) => void;
}) {
  function update(index: number, patch: Partial<FormField>) {
    onChange(
      fields.map((f, i) => {
        if (i !== index) return f;
        const next = { ...f, ...patch };
        // Keep the key in lockstep with the label so the merge tag is always
        // derived from what the user typed.
        if (patch.label !== undefined) next.key = slugifyFieldKey(patch.label);
        return next;
      }),
    );
  }

  function add(label: string, type: FormFieldType) {
    onChange([...fields, { key: slugifyFieldKey(label), label, type, required: false }]);
  }

  function remove(index: number) {
    onChange(fields.filter((_, i) => i !== index));
  }

  function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= fields.length) return;
    const next = [...fields];
    [next[index], next[target]] = [next[target], next[index]];
    onChange(next);
  }

  // Flag labels that collide on the same derived key — only the first survives a
  // save, so warn rather than silently dropping the duplicate.
  const keyCounts = new Map<string, number>();
  for (const f of fields) {
    const k = f.key || slugifyFieldKey(f.label);
    if (k) keyCounts.set(k, (keyCounts.get(k) ?? 0) + 1);
  }

  const presetsAvailable = PRESETS.filter(
    (p) => !fields.some((f) => f.key === slugifyFieldKey(p.label)),
  );

  return (
    <div className="space-y-3">
      {/* Email is non-negotiable — shown locked so the user sees the full picture. */}
      <div className="flex items-center gap-2 rounded-lg border border-dashed border-border bg-muted/30 px-3 py-2 text-sm">
        <GripVertical className="size-4 text-muted-foreground/40" />
        <span className="font-medium">Email</span>
        <span className="text-xs text-muted-foreground">· always collected · required</span>
      </div>

      {fields.map((field, i) => {
        const key = field.key || slugifyFieldKey(field.label);
        const duplicate = key !== "" && (keyCounts.get(key) ?? 0) > 1;
        return (
          <div key={i} className="rounded-lg border border-border p-3">
            <div className="flex items-start gap-2">
              <div className="flex flex-col">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={i === 0}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  aria-label="Move up"
                >
                  <ChevronUp className="size-4" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={i === fields.length - 1}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  aria-label="Move down"
                >
                  <ChevronDown className="size-4" />
                </button>
              </div>

              <div className="min-w-0 flex-1 space-y-2">
                <div className="flex gap-2">
                  <Input
                    value={field.label}
                    placeholder="Field label (e.g. Phone number)"
                    onChange={(e) => update(i, { label: e.target.value })}
                    className="flex-1"
                  />
                  <Select
                    items={TYPE_ITEMS}
                    value={field.type}
                    onValueChange={(v) => v && update(i, { type: v as FormFieldType })}
                  >
                    <SelectTrigger aria-label="Field type" className="w-28 shrink-0">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TYPE_ITEMS.map((t) => (
                        <SelectItem key={t.value} value={t.value}>
                          {t.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      type="checkbox"
                      className="size-3.5 accent-primary"
                      checked={field.required}
                      onChange={(e) => update(i, { required: e.target.checked })}
                    />
                    Required
                  </label>
                  <span className="truncate font-mono text-xs text-muted-foreground">
                    {mergeTagFor(field)}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => remove(i)}
                    className="text-destructive"
                    aria-label="Remove field"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>

                {duplicate && (
                  <p className="text-xs text-amber-600 dark:text-amber-500">
                    Another field already uses {mergeTagFor(field)} — give this one a different label.
                  </p>
                )}
              </div>
            </div>
          </div>
        );
      })}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        {presetsAvailable.map((p) => (
          <Button
            key={p.label}
            type="button"
            variant="outline"
            size="sm"
            onClick={() => add(p.label, p.type)}
          >
            <Plus className="size-3.5" /> {p.label}
          </Button>
        ))}
        <Button type="button" variant="outline" size="sm" onClick={() => add("", "text")}>
          <Plus className="size-3.5" /> Custom field
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Use a field anywhere in a campaign by typing its tag, e.g.{" "}
        <span className="font-mono">{"{{first_name}}"}</span>.
      </p>
    </div>
  );
}
