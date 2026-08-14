"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { Pencil, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrbitLoader } from "@/components/ui/orbit-loader";
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
  ListToolbar,
  RowActions,
  RowOpen,
  SortableHead,
  rowLinkProps,
  useListController,
} from "@/components/ui/data-list";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { ApiPanel } from "@/components/api-panel";
import { NextSteps } from "@/components/next-steps";
import { useApi } from "@/lib/api";
import { buildAudiencesPanelContent } from "@/lib/api-docs";
import { formatDate } from "@/lib/format";
import type { Audience, OnboardingState } from "@/lib/types";

export function AudiencesView({
  initialAudiences,
  onboarding,
}: {
  initialAudiences: Audience[];
  onboarding: OnboardingState;
}) {
  const api = useApi();
  const router = useRouter();
  // Seeded from the server render; owned locally so a rename/delete updates the row
  // without a refetch, and re-synced whenever the server sends a new list.
  const [audiences, setAudiences] = useState<Audience[]>(initialAudiences);
  useEffect(() => setAudiences(initialAudiences), [initialAudiences]);
  const [open, setOpen] = useState(false);
  const { register, handleSubmit, reset, formState } = useForm<{ name: string }>();

  // Rename + delete state, each keyed by the audience the action targets.
  const [renaming, setRenaming] = useState<Audience | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Audience | null>(null);
  const [deleting, setDeleting] = useState(false);

  const list = useListController(audiences, {
    searchText: (a) => a.name,
    sortAccessors: {
      name: (a) => a.name,
      subscribers: (a) => a.subscriberCount ?? 0,
      createdAt: (a) => a.createdAt,
    },
    initialSort: { key: "createdAt", dir: "desc" },
  });

  const onSubmit = handleSubmit(async (values) => {
    try {
      await api.post("/api/audiences", values);
      toast.success("Audience created");
      setOpen(false);
      reset();
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  });

  function openRename(a: Audience) {
    setRenaming(a);
    setRenameValue(a.name);
  }

  async function saveRename() {
    if (!renaming) return;
    const name = renameValue.trim();
    if (!name) return toast.error("Give the audience a name");
    setSavingRename(true);
    try {
      await api.patch(`/api/audiences/${renaming.id}`, { name });
      toast.success("Audience renamed");
      setAudiences((l) => l.map((a) => (a.id === renaming.id ? { ...a, name } : a)));
      setRenaming(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rename audience");
    } finally {
      setSavingRename(false);
    }
  }

  async function remove() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.del(`/api/audiences/${confirmDelete.id}`);
      toast.success("Audience deleted");
      setAudiences((l) => l.filter((a) => a.id !== confirmDelete.id));
      setConfirmDelete(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete audience");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1.5">
          <h1 className="font-display text-3xl">Audiences</h1>
          <ApiPanel build={(origin) => buildAudiencesPanelContent({ origin, audiences })} />
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button>New audience</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create audience</DialogTitle>
            </DialogHeader>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="name">Name</Label>
                <Input id="name" placeholder="Product updates" {...register("name", { required: true })} />
              </div>
              <Button type="submit" disabled={formState.isSubmitting} className="w-full">
                {formState.isSubmitting && <OrbitLoader size={16} />}
                Create
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <NextSteps onboarding={onboarding} hideWhenOn="audience" />

      {audiences.length > 0 && (
        <ListToolbar>
          <ListSearch value={list.search} onChange={list.setSearch} placeholder="Search audiences…" />
          <ListCount shown={list.shown} total={list.total} noun="audience" className="ml-auto" />
        </ListToolbar>
      )}

      <Card>
        <CardContent>
          {list.isEmpty ? (
            <ListEmpty
              icon={Users}
              title="Your first audience starts here."
              description="An audience is a list of people. Create one, then import the users you want to keep updated."
              action={<Button onClick={() => setOpen(true)}>New audience</Button>}
            />
          ) : list.isFilteredEmpty ? (
            <ListNoResults onClear={() => list.setSearch("")} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Name" sortKey="name" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Subscribed" sortKey="subscribers" sort={list.sort} onSort={list.toggleSort} align="right" />
                  <SortableHead label="Created" sortKey="createdAt" sort={list.sort} onSort={list.toggleSort} />
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.view.map((a) => (
                  <TableRow key={a.id} {...rowLinkProps(() => router.push(`/audiences/${a.id}`))}>
                    <TableCell>
                      <Link
                        href={`/audiences/${a.id}`}
                        className="font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(a.subscriberCount ?? 0).toLocaleString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(a.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <RowOpen href={`/audiences/${a.id}`} />
                        <RowActions>
                          <MenuItem onClick={() => openRename(a)}>
                            <Pencil />
                            Rename
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem variant="destructive" onClick={() => setConfirmDelete(a)}>
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

      <Dialog open={!!renaming} onOpenChange={(o) => !o && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename audience</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="renameAudience">Name</Label>
              <Input
                id="renameAudience"
                value={renameValue}
                autoFocus
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && saveRename()}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setRenaming(null)}>
                Cancel
              </Button>
              <Button onClick={saveRename} disabled={savingRename}>
                {savingRename && <OrbitLoader size={16} />}
                Save
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={`Delete "${confirmDelete?.name}"?`}
        description="This permanently deletes the audience and every subscriber in it. Campaigns already sent to it are unaffected. This can't be undone."
        confirmLabel="Delete audience"
        busy={deleting}
        onConfirm={remove}
      />
    </div>
  );
}
