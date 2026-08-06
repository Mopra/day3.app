"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Filter, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ListCount,
  ListEmpty,
  ListSearch,
  ListNoResults,
  ListSkeleton,
  ListToolbar,
  RowActions,
  SortableHead,
  useListController,
} from "@/components/ui/data-list";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { useApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { AudienceField, SegmentFilter, SegmentRow } from "@/lib/types";

// Mirrors lib/segment-filter.ts (kept as plain data here so the client bundle
// never pulls in the SQL builder).
const OPS = [
  { value: "equals", label: "is" },
  { value: "not_equals", label: "is not" },
  { value: "contains", label: "contains" },
  { value: "not_contains", label: "doesn't contain" },
  { value: "is_set", label: "has any value" },
  { value: "is_not_set", label: "is empty" },
  { value: "greater_than", label: "is greater than" },
  { value: "less_than", label: "is less than" },
] as const;
const VALUELESS = new Set(["is_set", "is_not_set"]);
const NUMERIC = new Set(["greater_than", "less_than"]);
const MAX_CONDITIONS = 10;

const BUILTIN_FIELDS = [
  { key: "email", label: "Email" },
  { key: "first_name", label: "First name" },
  { key: "last_name", label: "Last name" },
];

type DraftCondition = { field: string; op: string; value: string };
type Draft = { name: string; match: "all" | "any"; conditions: DraftCondition[] };

const EMPTY_DRAFT: Draft = {
  name: "",
  match: "all",
  conditions: [{ field: "email", op: "contains", value: "" }],
};

// A draft → the API filter shape, or null while it's incomplete (blank values
// on ops that need one). Used for both the live preview and save.
function draftFilter(draft: Draft): SegmentFilter | null {
  const conditions = draft.conditions.map((c) => ({
    field: c.field,
    op: c.op as SegmentFilter["conditions"][number]["op"],
    value: VALUELESS.has(c.op) ? undefined : c.value.trim(),
  }));
  for (const c of conditions) {
    if (!VALUELESS.has(c.op) && !c.value) return null;
    if (NUMERIC.has(c.op) && !/^-?\d+(\.\d+)?$/.test(c.value ?? "")) return null;
  }
  return { match: draft.match, conditions };
}

// The audience detail page's Segments tab: saved, named filters over the
// contacts — dynamic, so membership always reflects current data. Campaigns can
// send to a segment instead of the whole audience.
export function AudienceSegmentsTab({
  audienceId,
  segments,
  fields,
  onChanged,
}: {
  audienceId: string;
  // null while loading; the parent owns the fetch so the Contacts tab can offer
  // a segment filter from the same list.
  segments: SegmentRow[] | null;
  // The field registry — powers the condition builder's field dropdown.
  fields: AudienceField[] | null;
  onChanged: () => void;
}) {
  const api = useApi();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<SegmentRow | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const [confirmSegment, setConfirmSegment] = useState<SegmentRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Live "N contacts match" preview, debounced against the editor's filter.
  const [preview, setPreview] = useState<number | null>(null);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const filter = useMemo(() => (editorOpen ? draftFilter(draft) : null), [editorOpen, draft]);
  useEffect(() => {
    if (!filter) {
      setPreview(null);
      return;
    }
    if (previewTimer.current) clearTimeout(previewTimer.current);
    let live = true;
    previewTimer.current = setTimeout(() => {
      api
        .post<{ count: number }>(`/api/audiences/${audienceId}/segments/preview`, { filter })
        .then((res) => live && setPreview(res.count))
        .catch(() => live && setPreview(null));
    }, 350);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(filter), audienceId]);

  const fieldOptions = useMemo(
    () => [...BUILTIN_FIELDS, ...(fields ?? []).map((f) => ({ key: f.key, label: f.label }))],
    [fields],
  );

  const list = useListController(segments, {
    searchText: (s) => s.name,
    sortAccessors: {
      name: (s) => s.name,
      count: (s) => s.count ?? -1,
      created: (s) => s.createdAt,
    },
  });

  function openAdd() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setPreview(null);
    setEditorOpen(true);
  }

  function openEdit(s: SegmentRow) {
    setEditing(s);
    setDraft(
      s.filter
        ? {
            name: s.name,
            match: s.filter.match,
            conditions: s.filter.conditions.map((c) => ({
              field: c.field,
              op: c.op,
              value: c.value ?? "",
            })),
          }
        : { ...EMPTY_DRAFT, name: s.name },
    );
    setPreview(null);
    setEditorOpen(true);
  }

  async function save() {
    const name = draft.name.trim();
    if (!name) return toast.error("Give the segment a name");
    if (!filter) return toast.error("Fill in every condition first");
    setSaving(true);
    try {
      if (editing) {
        await api.patch(`/api/audiences/${audienceId}/segments/${editing.id}`, { name, filter });
        toast.success("Segment updated");
      } else {
        await api.post(`/api/audiences/${audienceId}/segments`, { name, filter });
        toast.success("Segment created");
      }
      setEditorOpen(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the segment");
    } finally {
      setSaving(false);
    }
  }

  async function removeSegment() {
    if (!confirmSegment) return;
    setDeleting(true);
    try {
      await api.del(`/api/audiences/${audienceId}/segments/${confirmSegment.id}`);
      toast.success("Segment deleted");
      setConfirmSegment(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete the segment");
    } finally {
      setDeleting(false);
    }
  }

  function setCondition(i: number, patch: Partial<DraftCondition>) {
    setDraft((d) => ({
      ...d,
      conditions: d.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    }));
  }

  return (
    <div className="space-y-6">
      {(list.total > 0 || list.search) && (
        <ListToolbar>
          <ListSearch value={list.search} onChange={list.setSearch} placeholder="Search segments…" />
          {list.total > 0 && (
            <ListCount shown={list.shown} total={list.total} noun="segment" className="ml-auto" />
          )}
          <Button size="sm" onClick={openAdd}>
            <Plus className="size-4" /> New segment
          </Button>
        </ListToolbar>
      )}

      <Card>
        <CardContent>
          {segments === null ? (
            <ListSkeleton />
          ) : list.isEmpty ? (
            <ListEmpty
              icon={Filter}
              title="Save a filter you'll reuse."
              description="A segment is a saved filter — “plan is pro”, “company has any value” — that always reflects your current contacts. Send a campaign to a segment instead of the whole audience."
              action={
                <Button onClick={openAdd}>
                  <Plus className="size-4" /> New segment
                </Button>
              }
            />
          ) : list.isFilteredEmpty ? (
            <ListNoResults onClear={() => list.setSearch("")} message="No segments match your search." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Name" sortKey="name" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Contacts" sortKey="count" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Created" sortKey="created" sort={list.sort} onSort={list.toggleSort} />
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(list.view ?? []).map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">{s.name}</TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {s.count === null ? "—" : s.count.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(s.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <RowActions label="Segment actions">
                          <MenuItem onClick={() => openEdit(s)}>
                            <Pencil />
                            Edit
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem variant="destructive" onClick={() => setConfirmSegment(s)}>
                            <Trash2 />
                            Delete
                          </MenuItem>
                        </RowActions>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Segment editor (create + edit) */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit segment" : "New segment"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="segmentName">Name</Label>
              <Input
                id="segmentName"
                placeholder="e.g. Pro customers"
                value={draft.name}
                autoFocus
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </div>

            <div className="space-y-2">
              <div className="flex items-center gap-2 text-sm">
                <span>Contacts matching</span>
                <Select
                  items={[
                    { value: "all", label: "all" },
                    { value: "any", label: "any" },
                  ]}
                  value={draft.match}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, match: (v as "all" | "any") ?? "all" }))
                  }
                >
                  <SelectTrigger aria-label="Match" className="h-8 w-20">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">all</SelectItem>
                    <SelectItem value="any">any</SelectItem>
                  </SelectContent>
                </Select>
                <span>of the conditions:</span>
              </div>

              <div className="space-y-2">
                {draft.conditions.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <Select
                      items={Object.fromEntries(fieldOptions.map((f) => [f.key, f.label]))}
                      value={c.field}
                      onValueChange={(v) => v && setCondition(i, { field: v as string })}
                    >
                      <SelectTrigger aria-label="Field" className="w-36 shrink-0">
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
                      <SelectTrigger aria-label="Operator" className="w-40 shrink-0">
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
                        className="flex-1"
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
                        setDraft((d) => ({
                          ...d,
                          conditions: d.conditions.filter((_, j) => j !== i),
                        }))
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
                  onClick={() =>
                    setDraft((d) => ({
                      ...d,
                      conditions: [...d.conditions, { field: "email", op: "contains", value: "" }],
                    }))
                  }
                >
                  <Plus className="size-3.5" /> Add condition
                </Button>
              )}
            </div>

            <p className="text-sm text-muted-foreground tabular-nums" aria-live="polite">
              {filter === null
                ? "Fill in every condition to see how many contacts match."
                : preview === null
                  ? "Counting…"
                  : `${preview.toLocaleString()} subscribed contact${preview === 1 ? "" : "s"} match right now.`}
            </p>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditorOpen(false)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving && <OrbitLoader size={16} />}
                {editing ? "Save" : "Create segment"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmSegment}
        onOpenChange={(o) => !o && setConfirmSegment(null)}
        title={`Delete "${confirmSegment?.name}"?`}
        description="Contacts are not affected — a segment is only a saved filter. Draft campaigns targeting it fall back to the whole audience."
        confirmLabel="Delete segment"
        busy={deleting}
        onConfirm={removeSegment}
      />
    </div>
  );
}
