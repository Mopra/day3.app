"use client";

import { useState } from "react";
import { Bell, Pencil, Plus, Trash2 } from "lucide-react";
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
import type { TopicRow } from "@/lib/types";

type Draft = { name: string; description: string; defaultSubscribed: "in" | "out" };

const EMPTY_DRAFT: Draft = { name: "", description: "", defaultSubscribed: "in" };

// The audience detail page's Topics tab: subscription categories ("Product
// updates", "Promotions") contacts can leave — or join — without unsubscribing
// from everything. Campaigns sent under a topic skip contacts who opted out,
// and the unsubscribe page offers a "just this topic" choice.
export function AudienceTopicsTab({
  topics,
  audienceId,
  onChanged,
}: {
  audienceId: string;
  // null while loading; the parent owns the fetch (shared with the edit dialog).
  topics: TopicRow[] | null;
  onChanged: () => void;
}) {
  const api = useApi();

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<TopicRow | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const [confirmTopic, setConfirmTopic] = useState<TopicRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const list = useListController(topics, {
    searchText: (t) => `${t.name} ${t.description ?? ""}`,
    sortAccessors: {
      name: (t) => t.name,
      audienceCount: (t) => (t.defaultSubscribed ? t.optedOut : t.optedIn),
      created: (t) => t.createdAt,
    },
  });

  function openAdd() {
    setEditing(null);
    setDraft(EMPTY_DRAFT);
    setEditorOpen(true);
  }

  function openEdit(t: TopicRow) {
    setEditing(t);
    setDraft({
      name: t.name,
      description: t.description ?? "",
      defaultSubscribed: t.defaultSubscribed ? "in" : "out",
    });
    setEditorOpen(true);
  }

  async function save() {
    const name = draft.name.trim();
    if (!name) return toast.error("Give the topic a name");
    setSaving(true);
    try {
      if (editing) {
        await api.patch(`/api/audiences/${audienceId}/topics/${editing.id}`, {
          name,
          description: draft.description.trim(),
        });
        toast.success("Topic updated");
      } else {
        await api.post(`/api/audiences/${audienceId}/topics`, {
          name,
          description: draft.description.trim(),
          defaultSubscribed: draft.defaultSubscribed === "in",
        });
        toast.success("Topic created");
      }
      setEditorOpen(false);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the topic");
    } finally {
      setSaving(false);
    }
  }

  async function removeTopic() {
    if (!confirmTopic) return;
    setDeleting(true);
    try {
      await api.del(`/api/audiences/${audienceId}/topics/${confirmTopic.id}`);
      toast.success("Topic deleted");
      setConfirmTopic(null);
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete the topic");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      {(list.total > 0 || list.search) && (
        <ListToolbar>
          <ListSearch value={list.search} onChange={list.setSearch} placeholder="Search topics…" />
          {list.total > 0 && (
            <ListCount shown={list.shown} total={list.total} noun="topic" className="ml-auto" />
          )}
          <Button size="sm" onClick={openAdd}>
            <Plus className="size-4" /> New topic
          </Button>
        </ListToolbar>
      )}

      <Card>
        <CardContent>
          {topics === null ? (
            <ListSkeleton />
          ) : list.isEmpty ? (
            <ListEmpty
              icon={Bell}
              title="No topics yet"
              description="Topics are subscription categories — “Product updates”, “Promotions” — contacts can leave without unsubscribing from everything. Send a campaign under a topic and anyone who opted out is skipped automatically."
              action={
                <Button onClick={openAdd}>
                  <Plus className="size-4" /> New topic
                </Button>
              }
            />
          ) : list.isFilteredEmpty ? (
            <ListNoResults onClear={() => list.setSearch("")} message="No topics match your search." />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Name" sortKey="name" sort={list.sort} onSort={list.toggleSort} />
                  <TableHead>Default</TableHead>
                  <SortableHead
                    label="Preferences"
                    sortKey="audienceCount"
                    sort={list.sort}
                    onSort={list.toggleSort}
                  />
                  <SortableHead label="Created" sortKey="created" sort={list.sort} onSort={list.toggleSort} />
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {(list.view ?? []).map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>
                      <div className="font-medium">{t.name}</div>
                      {t.description && (
                        <div className="max-w-xs truncate text-xs text-muted-foreground">
                          {t.description}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">
                        {t.defaultSubscribed ? "Everyone in" : "Opt-in only"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground tabular-nums">
                      {t.defaultSubscribed
                        ? `${t.optedOut.toLocaleString()} opted out`
                        : `${t.optedIn.toLocaleString()} opted in`}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {formatDateTime(t.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <RowActions label="Topic actions">
                          <MenuItem onClick={() => openEdit(t)}>
                            <Pencil />
                            Edit
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem variant="destructive" onClick={() => setConfirmTopic(t)}>
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

      {/* Topic editor (create + edit) */}
      <Dialog open={editorOpen} onOpenChange={setEditorOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit topic" : "New topic"}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="topicName">Name</Label>
              <Input
                id="topicName"
                placeholder="e.g. Product updates"
                value={draft.name}
                autoFocus
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="topicDescription">Description</Label>
              <Input
                id="topicDescription"
                placeholder="Optional — shown to your team, not to contacts"
                value={draft.description}
                onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
              />
            </div>
            {editing ? (
              <p className="text-xs text-muted-foreground">
                {editing.defaultSubscribed
                  ? "Everyone is subscribed unless they opt out. This can't be changed after creation."
                  : "Contacts receive this topic only after opting in. This can't be changed after creation."}
              </p>
            ) : (
              <div className="space-y-2">
                <Label>Who's subscribed to start with?</Label>
                <Select
                  items={{
                    in: "Everyone — contacts can opt out",
                    out: "No one — contacts must opt in",
                  }}
                  value={draft.defaultSubscribed}
                  onValueChange={(v) =>
                    setDraft((d) => ({ ...d, defaultSubscribed: (v as "in" | "out") ?? "in" }))
                  }
                >
                  <SelectTrigger aria-label="Default subscription" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="in">Everyone — contacts can opt out</SelectItem>
                    <SelectItem value="out">No one — contacts must opt in</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  Can&apos;t be changed later — it decides what every stored preference means.
                </p>
              </div>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEditorOpen(false)}>
                Cancel
              </Button>
              <Button onClick={save} disabled={saving}>
                {saving && <OrbitLoader size={16} />}
                {editing ? "Save" : "Create topic"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmTopic}
        onOpenChange={(o) => !o && setConfirmTopic(null)}
        title={`Delete "${confirmTopic?.name}"?`}
        description="Contacts stay subscribed to your emails — only this topic and its saved preferences are removed. Draft campaigns sent under it fall back to no topic."
        confirmLabel="Delete topic"
        busy={deleting}
        onConfirm={removeTopic}
      />
    </div>
  );
}
