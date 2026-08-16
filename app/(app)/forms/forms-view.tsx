"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileInput, Power, PowerOff, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
  ListFilter,
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
import { useApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { Audience, SignupForm } from "@/lib/types";

const STATUS_OPTIONS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "disabled", label: "Off" },
];

export function FormsView({
  initialForms,
  initialAudiences,
}: {
  initialForms: SignupForm[];
  initialAudiences: Audience[];
}) {
  const api = useApi();
  const router = useRouter();
  // Seeded from the server render. Mutations update the row locally and then
  // router.refresh() re-runs the server component, so the two stay in step.
  const [forms, setForms] = useState<SignupForm[]>(initialForms);
  const [audiences, setAudiences] = useState<Audience[]>(initialAudiences);
  useEffect(() => {
    setForms(initialForms);
    setAudiences(initialAudiences);
  }, [initialForms, initialAudiences]);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [status, setStatus] = useState("all");
  const [confirmDelete, setConfirmDelete] = useState<SignupForm | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [name, setName] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const [doubleOptIn, setDoubleOptIn] = useState(true);
  const [collectName, setCollectName] = useState(false);


  const list = useListController(forms, {
    searchText: (f) => `${f.name} ${f.audienceName ?? ""}`,
    predicate: (f) => status === "all" || f.status === status,
    sortAccessors: {
      name: (f) => f.name,
      audience: (f) => f.audienceName,
      status: (f) => f.status,
      signups: (f) => f.submitCount,
      confirmed: (f) => f.confirmedCount,
      createdAt: (f) => f.createdAt,
    },
    initialSort: { key: "createdAt", dir: "desc" },
  });

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setName("");
      setAudienceId("");
      setDoubleOptIn(true);
      setCollectName(false);
    }
  }

  async function create() {
    if (!name.trim()) return toast.error("Give your form a name");
    if (!audienceId) return toast.error("Choose an audience");
    setSubmitting(true);
    try {
      const res = await api.post<{ form: { id: string } }>("/api/forms", {
        name: name.trim(),
        audienceId,
        doubleOptIn,
        collectName,
      });
      toast.success("Form created");
      openChange(false);
      router.push(`/forms/${res.form.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create form");
    } finally {
      setSubmitting(false);
    }
  }

  async function toggleStatus(f: SignupForm) {
    const next = f.status === "active" ? "disabled" : "active";
    try {
      await api.patch(`/api/forms/${f.id}`, { status: next });
      toast.success(next === "active" ? "Form turned on" : "Form turned off");
      setForms((l) => l.map((x) => (x.id === f.id ? { ...x, status: next } : x)));
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update form");
    }
  }

  async function remove() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await api.del(`/api/forms/${confirmDelete.id}`);
      toast.success("Form deleted");
      setForms((l) => l.filter((f) => f.id !== confirmDelete.id));
      setConfirmDelete(null);
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete form");
    } finally {
      setDeleting(false);
    }
  }

  function clearFilters() {
    list.setSearch("");
    setStatus("all");
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl sm:text-3xl">Signup forms</h1>
        <Dialog open={open} onOpenChange={openChange}>
          <DialogTrigger render={<Button disabled={audiences.length === 0}>New form</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create a signup form</DialogTitle>
              <DialogDescription>
                Collect newsletter signups from your website, a shared link, or an embed. You can
                fine-tune the design and copy next.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Form name</Label>
                <Input
                  id="name"
                  placeholder="Website newsletter"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Just for you — subscribers won&apos;t see it.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Audience</Label>
                <Select items={audiences.map((a) => ({ value: a.id, label: a.name }))} value={audienceId} onValueChange={(v) => setAudienceId(v as string)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose an audience" />
                  </SelectTrigger>
                  <SelectContent>
                    {audiences.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Signups land in this audience.</p>
              </div>
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={doubleOptIn}
                  onChange={(e) => setDoubleOptIn(e.target.checked)}
                />
                <span>
                  <span className="font-medium">Require email confirmation</span>
                  <span className="block text-xs text-muted-foreground">
                    Recommended. New signups confirm via email before they can be sent campaigns —
                    protects your sender reputation from bots and typos.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={collectName}
                  onChange={(e) => setCollectName(e.target.checked)}
                />
                <span>
                  <span className="font-medium">Also ask for first name</span>
                  <span className="block text-xs text-muted-foreground">
                    Lets you personalize campaigns with a merge tag.
                  </span>
                </span>
              </label>
              <Button onClick={create} disabled={submitting} className="w-full">
                {submitting && <OrbitLoader size={16} />}
                Create form
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      {forms.length > 0 && (
        <ListToolbar>
          <ListSearch value={list.search} onChange={list.setSearch} placeholder="Search forms…" />
          <ListFilter
            value={status}
            onChange={setStatus}
            options={STATUS_OPTIONS}
            ariaLabel="Filter by status"
          />
          <ListCount shown={list.shown} total={list.total} noun="form" className="ml-auto" />
        </ListToolbar>
      )}

      <Card>
        <CardContent>
          {list.isEmpty ? (
            <ListEmpty
              icon={FileInput}
              title="Start collecting signups."
              description={
                audiences.length === 0
                  ? "First create an audience — signups need somewhere to land."
                  : "Share a link, embed it on your site, or drop in raw HTML. Signups flow straight into your audience."
              }
              action={
                audiences.length === 0 ? (
                  <Button render={<Link href="/audiences">Create an audience</Link>} />
                ) : (
                  <Button onClick={() => setOpen(true)}>New form</Button>
                )
              }
            />
          ) : list.isFilteredEmpty ? (
            <ListNoResults onClear={clearFilters} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Name" sortKey="name" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Audience" sortKey="audience" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Status" sortKey="status" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Signups" sortKey="signups" sort={list.sort} onSort={list.toggleSort} align="right" />
                  <SortableHead label="Confirmed" sortKey="confirmed" sort={list.sort} onSort={list.toggleSort} align="right" />
                  <SortableHead label="Created" sortKey="createdAt" sort={list.sort} onSort={list.toggleSort} />
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.view.map((f) => (
                  <TableRow key={f.id} {...rowLinkProps(() => router.push(`/forms/${f.id}`))}>
                    <TableCell>
                      <Link
                        href={`/forms/${f.id}`}
                        className="font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {f.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{f.audienceName ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={f.status === "active" ? "default" : "secondary"}>
                        {f.status === "active" ? "Active" : "Off"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{f.submitCount.toLocaleString()}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.confirmedCount.toLocaleString()}</TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(f.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <RowOpen href={`/forms/${f.id}`} />
                        <RowActions>
                          <MenuItem onClick={() => toggleStatus(f)}>
                            {f.status === "active" ? <PowerOff /> : <Power />}
                            {f.status === "active" ? "Turn off" : "Turn on"}
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem variant="destructive" onClick={() => setConfirmDelete(f)}>
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

      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(o) => !o && setConfirmDelete(null)}
        title={`Delete "${confirmDelete?.name}"?`}
        description="This permanently deletes the form and its hosted page and embed. Subscribers already collected stay in their audience. This can't be undone."
        confirmLabel="Delete form"
        busy={deleting}
        onConfirm={remove}
      />
    </div>
  );
}
