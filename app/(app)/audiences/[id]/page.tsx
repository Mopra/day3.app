"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { Pencil, Trash2, Users } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Alert, AlertDescription } from "@/components/ui/alert";
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
import { Progress } from "@/components/ui/progress";
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
  ListSkeleton,
  ListToolbar,
} from "@/components/ui/data-list";
import { useApi } from "@/lib/api";
import { formatDateTime, statusVariant } from "@/lib/format";
import type { Audience, ImportRow, Subscriber } from "@/lib/types";

const STATUS_FILTERS = [
  { value: "all", label: "All statuses" },
  { value: "subscribed", label: "Subscribed" },
  { value: "unsubscribed", label: "Unsubscribed" },
  { value: "bounced", label: "Bounced" },
  { value: "complained", label: "Complained" },
  { value: "suppressed", label: "Suppressed" },
];

// One server page. The list endpoint caps a request at 100 rows, so we page in
// 50s and let "Load more" fetch the next page.
const PAGE = 50;

type AddForm = { email: string; firstName?: string; lastName?: string };

type EditForm = { email: string; firstName?: string; lastName?: string };

export default function AudienceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const router = useRouter();
  const [audience, setAudience] = useState<Audience | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [subscribers, setSubscribers] = useState<Subscriber[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [imports, setImports] = useState<ImportRow[]>([]);
  // `searchInput` is what the user types; `search` is the debounced value we
  // actually query with, so we don't hit the API on every keystroke.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [addOpen, setAddOpen] = useState(false);

  // Audience rename + delete.
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [savingRename, setSavingRename] = useState(false);
  const [deleteAudienceOpen, setDeleteAudienceOpen] = useState(false);
  const [deletingAudience, setDeletingAudience] = useState(false);

  // Per-subscriber edit + delete, keyed by the row being acted on.
  const [editSub, setEditSub] = useState<Subscriber | null>(null);
  const [confirmSub, setConfirmSub] = useState<Subscriber | null>(null);
  const [deletingSub, setDeletingSub] = useState(false);
  const editForm = useForm<EditForm>();
  const fileRef = useRef<HTMLInputElement>(null);
  // Holds the import id awaiting a re-uploaded CSV when the user clicks "Retry"
  // on a failed import; the same hidden picker is reused for the corrected file.
  const retryRef = useRef<HTMLInputElement>(null);
  const [retryImportId, setRetryImportId] = useState<string | null>(null);
  const { register, handleSubmit, reset, formState } = useForm<AddForm>();

  const loadAudience = useCallback(() => {
    api
      .get<{ audience: Audience; counts: Record<string, number> }>(`/api/audiences/${id}`)
      .then((res) => {
        setAudience(res.audience);
        setCounts(res.counts);
      })
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Debounce the search box → query value.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  const subscribersUrl = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (status !== "all") params.set("status", status);
      if (search) params.set("search", search);
      return `/api/audiences/${id}/subscribers?${params}`;
    },
    [id, status, search],
  );

  // (Re)load the first page. Runs on mount and whenever the filters change; also
  // called after any mutation to refresh the visible rows.
  const loadSubscribers = useCallback(() => {
    api
      .get<{ subscribers: Subscriber[]; total: number }>(subscribersUrl(0))
      .then((res) => {
        setSubscribers(res.subscribers);
        setTotal(res.total);
      })
      .catch((err) => toast.error(err.message));
  }, [api, subscribersUrl]);

  const loadImports = useCallback(() => {
    api
      .get<{ imports: ImportRow[] }>(`/api/audiences/${id}/imports`)
      .then((res) => setImports(res.imports))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(loadAudience, [loadAudience]);
  useEffect(loadSubscribers, [loadSubscribers]);
  useEffect(loadImports, [loadImports]);

  async function loadMore() {
    if (!subscribers || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.get<{ subscribers: Subscriber[]; total: number }>(
        subscribersUrl(subscribers.length),
      );
      setSubscribers((cur) => [...(cur ?? []), ...res.subscribers]);
      setTotal(res.total);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load more");
    } finally {
      setLoadingMore(false);
    }
  }

  // Poll while an import is running.
  const hasRunningImport = imports.some((i) => i.status === "pending" || i.status === "processing");
  useEffect(() => {
    if (!hasRunningImport) return;
    const t = setInterval(() => {
      loadImports();
      loadSubscribers();
      loadAudience();
    }, 2000);
    return () => clearInterval(t);
  }, [hasRunningImport, loadImports, loadSubscribers, loadAudience]);

  const onAdd = handleSubmit(async (values) => {
    try {
      await api.post(`/api/audiences/${id}/subscribers`, values);
      toast.success("Subscriber added");
      setAddOpen(false);
      reset();
      loadSubscribers();
      loadAudience();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    }
  });

  async function onUpload(file: File) {
    const form = new FormData();
    form.append("file", file);
    try {
      await api.upload(`/api/audiences/${id}/import`, form);
      toast.success("Import started");
      loadImports();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
    }
  }

  // Re-upload a corrected CSV for a previously failed import. Re-running the same
  // import row is dedup-safe, so already-imported subscribers are never doubled.
  async function onRetryUpload(importId: string, file: File) {
    const form = new FormData();
    form.append("file", file);
    try {
      await api.upload(`/api/audiences/${id}/imports/${importId}/retry`, form);
      toast.success("Retrying import");
      loadImports();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retry failed");
    }
  }

  async function saveRename() {
    const name = renameValue.trim();
    if (!name) return toast.error("Give the audience a name");
    setSavingRename(true);
    try {
      await api.patch(`/api/audiences/${id}`, { name });
      toast.success("Audience renamed");
      setAudience((a) => (a ? { ...a, name } : a));
      setRenameOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rename audience");
    } finally {
      setSavingRename(false);
    }
  }

  async function removeAudience() {
    setDeletingAudience(true);
    try {
      await api.del(`/api/audiences/${id}`);
      toast.success("Audience deleted");
      router.push("/audiences");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete audience");
      setDeletingAudience(false);
    }
  }

  function openEditSub(s: Subscriber) {
    setEditSub(s);
    editForm.reset({
      email: s.email,
      firstName: s.firstName ?? "",
      lastName: s.lastName ?? "",
    });
  }

  const onEditSub = editForm.handleSubmit(async (values) => {
    if (!editSub) return;
    try {
      await api.patch(`/api/subscribers/${editSub.id}`, values);
      toast.success("Subscriber updated");
      setEditSub(null);
      loadSubscribers();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update subscriber");
    }
  });

  async function removeSub() {
    if (!confirmSub) return;
    setDeletingSub(true);
    try {
      await api.del(`/api/subscribers/${confirmSub.id}`);
      toast.success("Subscriber removed");
      setConfirmSub(null);
      loadSubscribers();
      loadAudience();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove subscriber");
    } finally {
      setDeletingSub(false);
    }
  }

  const filtersActive = !!search || status !== "all";
  const shown = subscribers?.length ?? 0;
  const hasMore = shown < total;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{audience?.name ?? "…"}</h1>
            {audience && (
              <>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Rename audience"
                  className="text-muted-foreground"
                  onClick={() => {
                    setRenameValue(audience.name);
                    setRenameOpen(true);
                  }}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Delete audience"
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => setDeleteAudienceOpen(true)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </>
            )}
          </div>
          <p className="text-sm text-muted-foreground tabular-nums">
            {(counts.subscribed ?? 0).toLocaleString()} subscribed
          </p>
        </div>
        <div className="flex gap-2">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) onUpload(file);
              e.target.value = "";
            }}
          />
          <Button variant="outline" onClick={() => fileRef.current?.click()}>
            Import CSV
          </Button>
          <Dialog open={addOpen} onOpenChange={setAddOpen}>
            <DialogTrigger render={<Button>Add subscriber</Button>} />
            <DialogContent>
              <DialogHeader>
                <DialogTitle>Add subscriber</DialogTitle>
              </DialogHeader>
              <form onSubmit={onAdd} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">Email</Label>
                  <Input id="email" type="email" {...register("email", { required: true })} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-2">
                    <Label htmlFor="firstName">First name</Label>
                    <Input id="firstName" {...register("firstName")} />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lastName">Last name</Label>
                    <Input id="lastName" {...register("lastName")} />
                  </div>
                </div>
                <Button type="submit" disabled={formState.isSubmitting} className="w-full">
                  Add
                </Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>
      </div>

      {/* Hidden picker reused for re-uploading a corrected CSV on retry. */}
      <input
        ref={retryRef}
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file && retryImportId) onRetryUpload(retryImportId, file);
          setRetryImportId(null);
          e.target.value = "";
        }}
      />

      {imports.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Import history</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {imports.slice(0, 5).map((imp) => (
              <div key={imp.id} className="space-y-1">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{imp.filename}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground">
                      {imp.totalRows > 0
                        ? `${imp.importedRows} imported · ${imp.skippedRows} skipped · ${imp.totalRows} total`
                        : null}
                    </span>
                    <Badge variant={statusVariant(imp.status)}>{imp.status}</Badge>
                  </div>
                </div>
                {(imp.status === "pending" || imp.status === "processing") && (
                  <Progress value={imp.status === "pending" ? 5 : 50} />
                )}
                {imp.status === "failed" && (
                  <Alert variant="destructive">
                    <AlertDescription className="flex flex-wrap items-center justify-between gap-2">
                      <span>{imp.error ?? "The import failed."}</span>
                      <Button
                        variant="outline"
                        size="xs"
                        onClick={() => {
                          setRetryImportId(imp.id);
                          retryRef.current?.click();
                        }}
                      >
                        Re-upload &amp; retry
                      </Button>
                    </AlertDescription>
                  </Alert>
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {(filtersActive || shown > 0) && (
        <ListToolbar>
          <ListSearch value={searchInput} onChange={setSearchInput} placeholder="Search by email…" />
          <ListFilter
            value={status}
            onChange={setStatus}
            options={STATUS_FILTERS}
            ariaLabel="Filter by status"
          />
          {total > 0 && (
            <ListCount shown={shown} total={total} noun="subscriber" className="ml-auto" />
          )}
        </ListToolbar>
      )}

      <Card>
        <CardContent>
          {subscribers === null ? (
            <ListSkeleton />
          ) : subscribers.length === 0 ? (
            filtersActive ? (
              <ListNoResults
                onClear={() => {
                  setSearchInput("");
                  setStatus("all");
                }}
                message="No subscribers match your search."
              />
            ) : (
              <ListEmpty
                icon={Users}
                title="No subscribers yet"
                description={
                  <>
                    Import a CSV with an <code>email</code> column (optional{" "}
                    <code>first_name</code>, <code>last_name</code>) — up to 5,000 rows — or add
                    someone by hand.
                  </>
                }
                action={
                  <Button variant="outline" onClick={() => fileRef.current?.click()}>
                    Import CSV
                  </Button>
                }
              />
            )
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Added</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {subscribers.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell className="font-medium">{s.email}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {[s.firstName, s.lastName].filter(Boolean).join(" ") || "—"}
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(s.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          {s.status === "subscribed" && (
                            <Button
                              variant="ghost"
                              size="xs"
                              onClick={async () => {
                                try {
                                  await api.post(`/api/subscribers/${s.id}/unsubscribe`);
                                  loadSubscribers();
                                  loadAudience();
                                } catch (err) {
                                  toast.error(err instanceof Error ? err.message : "Failed");
                                }
                              }}
                            >
                              Unsubscribe
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Edit subscriber"
                            title="Edit"
                            className="text-muted-foreground"
                            onClick={() => openEditSub(s)}
                          >
                            <Pencil className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            aria-label="Delete subscriber"
                            title="Remove"
                            className="text-muted-foreground hover:text-destructive"
                            onClick={() => setConfirmSub(s)}
                          >
                            <Trash2 className="size-4" />
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {hasMore && (
                <div className="flex justify-center pt-4">
                  <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore && <OrbitLoader size={16} />}
                    Load more
                    <span className="text-muted-foreground tabular-nums">
                      ({(total - shown).toLocaleString()} more)
                    </span>
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Rename audience */}
      <Dialog open={renameOpen} onOpenChange={setRenameOpen}>
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
              <Button variant="ghost" onClick={() => setRenameOpen(false)}>
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

      {/* Edit subscriber */}
      <Dialog open={!!editSub} onOpenChange={(o) => !o && setEditSub(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Edit subscriber</DialogTitle>
          </DialogHeader>
          <form onSubmit={onEditSub} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="editEmail">Email</Label>
              <Input
                id="editEmail"
                type="email"
                {...editForm.register("email", { required: true })}
              />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-2">
                <Label htmlFor="editFirstName">First name</Label>
                <Input id="editFirstName" {...editForm.register("firstName")} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="editLastName">Last name</Label>
                <Input id="editLastName" {...editForm.register("lastName")} />
              </div>
            </div>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setEditSub(null)}>
                Cancel
              </Button>
              <Button type="submit" disabled={editForm.formState.isSubmitting}>
                {editForm.formState.isSubmitting && <OrbitLoader size={16} />}
                Save
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={deleteAudienceOpen}
        onOpenChange={setDeleteAudienceOpen}
        title={`Delete "${audience?.name}"?`}
        description="This permanently deletes the audience and every subscriber in it. Campaigns already sent to it are unaffected. This can't be undone."
        confirmLabel="Delete audience"
        busy={deletingAudience}
        onConfirm={removeAudience}
      />

      <ConfirmDialog
        open={!!confirmSub}
        onOpenChange={(o) => !o && setConfirmSub(null)}
        title="Remove this subscriber?"
        description={
          <>
            {confirmSub?.email} will be permanently removed from this audience. To stop
            mailing them without deleting, use Unsubscribe instead.
          </>
        }
        confirmLabel="Remove subscriber"
        busy={deletingSub}
        onConfirm={removeSub}
      />
    </div>
  );
}
