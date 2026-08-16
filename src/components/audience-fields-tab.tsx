"use client";

import { useState } from "react";
import { Pencil, Plus, Tags, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
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
  ListNoResults,
  ListSearch,
  ListSkeleton,
  ListToolbar,
  RowActions,
  SortableHead,
  useListController,
} from "@/components/ui/data-list";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { useApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { AudienceField } from "@/lib/types";

// "Phone number" → "phone_number" — client-side mirror of slugifyFieldKey, so
// the add dialog can preview the merge tag as the user types a label.
function previewKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
}

const TYPE_OPTIONS: { value: AudienceField["type"]; label: string }[] = [
  { value: "text", label: "Text" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
];

type FieldDraft = {
  label: string;
  key: string;
  keyTouched: boolean;
  type: AudienceField["type"];
  fallback: string;
};

const EMPTY_DRAFT: FieldDraft = { label: "", key: "", keyTouched: false, type: "text", fallback: "" };

// The audience detail page's Fields tab: the custom-field registry — every
// field this audience's contacts can carry (from signup forms, CSV imports,
// manual edits, or created here), each usable as a {{merge_tag}} in campaigns.
export function AudienceFieldsTab({
  audienceId,
  fields,
  onChanged,
}: {
  audienceId: string;
  // null while loading; the parent owns the fetch so the Contacts tab can share
  // the registry for its table columns.
  fields: AudienceField[] | null;
  onChanged: () => void;
}) {
  const api = useApi();

  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState<FieldDraft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const [editField, setEditField] = useState<AudienceField | null>(null);

  const [confirmField, setConfirmField] = useState<AudienceField | null>(null);
  const [purgeValues, setPurgeValues] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const list = useListController(fields, {
    searchText: (f) => `${f.label} ${f.key}`,
    sortAccessors: {
      label: (f) => f.label,
      type: (f) => f.type,
      fallback: (f) => f.fallback ?? "",
      created: (f) => f.createdAt,
    },
  });

  function openAdd() {
    setDraft(EMPTY_DRAFT);
    setAddOpen(true);
  }

  function openEdit(f: AudienceField) {
    setDraft({ label: f.label, key: f.key, keyTouched: true, type: f.type, fallback: f.fallback ?? "" });
    setEditField(f);
  }

  async function saveNew() {
    const label = draft.label.trim();
    if (!label) return toast.error("Give the field a name");
    setSaving(true);
    try {
      await api.post(`/api/audiences/${audienceId}/fields`, {
        label,
        key: draft.keyTouched ? draft.key : undefined,
        type: draft.type,
        fallback: draft.fallback.trim(),
      });
      toast.success("Field added");
      setAddOpen(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add the field");
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit() {
    if (!editField) return;
    const label = draft.label.trim();
    if (!label) return toast.error("Give the field a name");
    setSaving(true);
    try {
      await api.patch(`/api/audiences/${audienceId}/fields/${editField.id}`, {
        label,
        type: draft.type,
        fallback: draft.fallback.trim(),
      });
      toast.success("Field updated");
      setEditField(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update the field");
    } finally {
      setSaving(false);
    }
  }

  async function removeField() {
    if (!confirmField) return;
    setDeleting(true);
    try {
      await api.del(
        `/api/audiences/${audienceId}/fields/${confirmField.id}${purgeValues ? "?purge=1" : ""}`,
      );
      toast.success("Field deleted");
      setConfirmField(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete the field");
    } finally {
      setDeleting(false);
    }
  }

  // Shared label/type/fallback inputs for the add + edit dialogs. The key is
  // only editable on create (it's the merge tag and the stored data key).
  function draftInputs(mode: "add" | "edit") {
    return (
      <>
        <div className="space-y-2">
          <Label htmlFor="fieldLabel">Name</Label>
          <Input
            id="fieldLabel"
            placeholder="e.g. Company"
            value={draft.label}
            autoFocus
            onChange={(e) => setDraft((d) => ({ ...d, label: e.target.value }))}
          />
        </div>
        {mode === "add" ? (
          <div className="space-y-2">
            <Label htmlFor="fieldKey">Merge tag</Label>
            <Input
              id="fieldKey"
              className="font-mono"
              placeholder="company"
              value={draft.keyTouched ? draft.key : previewKey(draft.label)}
              onChange={(e) =>
                setDraft((d) => ({ ...d, key: e.target.value, keyTouched: true }))
              }
            />
            <p className="text-xs text-muted-foreground">
              Use it in campaigns as{" "}
              <code className="font-mono">
                {`{{${(draft.keyTouched ? draft.key : previewKey(draft.label)) || "field_name"}}}`}
              </code>
              . Can&apos;t be changed later.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            <Label>Merge tag</Label>
            <p className="rounded-md border bg-muted/50 px-3 py-2 font-mono text-sm text-muted-foreground">
              {`{{${draft.key}}}`}
            </p>
          </div>
        )}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Type</Label>
            <Select
              items={TYPE_OPTIONS}
              value={draft.type}
              onValueChange={(v) =>
                setDraft((d) => ({ ...d, type: (v as AudienceField["type"]) ?? "text" }))
              }
            >
              <SelectTrigger aria-label="Field type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TYPE_OPTIONS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fieldFallback">Fallback value</Label>
            <Input
              id="fieldFallback"
              placeholder="Optional"
              value={draft.fallback}
              onChange={(e) => setDraft((d) => ({ ...d, fallback: e.target.value }))}
            />
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          The fallback is used in emails when a contact has no value for this field.
        </p>
      </>
    );
  }

  return (
    <div className="space-y-6">
      {(list.total > 0 || list.search) && (
        <ListToolbar>
          <ListSearch value={list.search} onChange={list.setSearch} placeholder="Search fields…" />
          {list.total > 0 && (
            <ListCount shown={list.shown} total={list.total} noun="field" className="ml-auto" />
          )}
          <Button size="sm" onClick={openAdd}>
            <Plus className="size-4" /> Add field
          </Button>
        </ListToolbar>
      )}

      <Card>
        <CardContent>
          {fields === null ? (
            <ListSkeleton />
          ) : list.isEmpty ? (
            <ListEmpty
              icon={Tags}
              title="Keep track of what else you know."
              description="Fields hold extra information about your contacts — a company, a plan, a signup date. Each one becomes a {{merge_tag}} you can use in campaigns. They're also added automatically when a CSV import or signup form brings a new column."
              action={
                <Button onClick={openAdd}>
                  <Plus className="size-4" /> Add field
                </Button>
              }
            />
          ) : list.isFilteredEmpty ? (
            <ListNoResults
              onClear={() => list.setSearch("")}
              message="No fields match your search."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Name" sortKey="label" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Type" sortKey="type" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead
                    label="Fallback value"
                    sortKey="fallback"
                    sort={list.sort}
                    onSort={list.toggleSort}
                  />
                  <SortableHead
                    label="Created"
                    sortKey="created"
                    sort={list.sort}
                    onSort={list.toggleSort}
                  />
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(list.view ?? []).map((f) => (
                  <TableRow key={f.id}>
                    <TableCell>
                      <div className="font-medium">{f.label}</div>
                      <div className="font-mono text-xs text-muted-foreground">{`{{${f.key}}}`}</div>
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary" className="font-mono text-xs">
                        {f.type}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{f.fallback || "—"}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(f.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <RowActions label="Field actions">
                          <MenuItem onClick={() => openEdit(f)}>
                            <Pencil />
                            Edit
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            variant="destructive"
                            onClick={() => {
                              setPurgeValues(false);
                              setConfirmField(f);
                            }}
                          >
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

      {/* Add field */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add field</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {draftInputs("add")}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button onClick={saveNew} disabled={saving}>
                {saving && <OrbitLoader size={16} />}
                Add field
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Edit field */}
      <Dialog open={!!editField} onOpenChange={(o) => !o && setEditField(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit field</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {draftInputs("edit")}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditField(null)}>
                Cancel
              </Button>
              <Button onClick={saveEdit} disabled={saving}>
                {saving && <OrbitLoader size={16} />}
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmField}
        onOpenChange={(o) => !o && setConfirmField(null)}
        title={`Delete "${confirmField?.label}"?`}
        description={
          <>
            The field disappears from this list, the contacts table, and the campaign
            merge-tag menu. Campaigns using{" "}
            <code className="font-mono">{`{{${confirmField?.key}}}`}</code> will render its
            fallback or nothing. If you keep the stored values, the field can reappear when
            new data arrives with this column.
            <label className="mt-3 flex cursor-pointer items-start gap-2 text-foreground">
              <input
                type="checkbox"
                className="mt-0.5 size-4 accent-primary"
                checked={purgeValues}
                onChange={(e) => setPurgeValues(e.target.checked)}
              />
              <span>Also delete the stored values from all contacts</span>
            </label>
          </>
        }
        confirmLabel="Delete field"
        busy={deleting}
        onConfirm={removeField}
      />
    </div>
  );
}
