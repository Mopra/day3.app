"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { Pencil, Plus, Trash2, UserMinus, Users } from "lucide-react";
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
  RowActions,
} from "@/components/ui/data-list";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AudienceFieldsTab } from "@/components/audience-fields-tab";
import { AudienceSegmentsTab } from "@/components/audience-segments-tab";
import { AudienceTopicsTab } from "@/components/audience-topics-tab";
import { useApi } from "@/lib/api";
import { SUBSCRIBER_CSV_TEMPLATE } from "@/lib/csv";
import { formatDateTime, statusVariant } from "@/lib/format";
import type {
  Audience,
  AudienceField,
  ImportRow,
  SegmentRow,
  Subscriber,
  SubscriberTopic,
  TopicRow,
} from "@/lib/types";

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

// Turn the per-reason skip counts into a plain-language sentence, so "N skipped"
// stops being a black box (duplicates? bad emails? suppressed? over the cap?).
function importSkipBreakdown(imp: ImportRow): string {
  const parts: string[] = [];
  if (imp.duplicateRows > 0)
    parts.push(`${imp.duplicateRows.toLocaleString()} already in this audience`);
  if (imp.invalidRows > 0) parts.push(`${imp.invalidRows.toLocaleString()} invalid email${imp.invalidRows === 1 ? "" : "s"}`);
  if (imp.suppressedRows > 0)
    parts.push(`${imp.suppressedRows.toLocaleString()} previously unsubscribed or bounced`);
  if (imp.overCapRows > 0)
    parts.push(`${imp.overCapRows.toLocaleString()} over your plan's subscriber limit`);
  return parts.length > 0 ? `${parts.join(" · ")}.` : "";
}

type AddForm = { email: string; firstName?: string; lastName?: string };

type EditForm = { email: string; firstName?: string; lastName?: string };

// Custom attributes are edited as an ordered list of key/value pairs, then folded
// back into a {key: value} map for the API.
type Pair = { key: string; value: string };

function pairsFromAttrs(a: Record<string, string> | null | undefined): Pair[] {
  return a ? Object.entries(a).map(([key, value]) => ({ key, value })) : [];
}

function attrsFromPairs(pairs: Pair[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    const k = key.trim();
    if (k && value.trim()) out[k] = value.trim();
  }
  return out;
}

// Reusable key/value editor for a subscriber's custom fields, used in both the
// add and edit dialogs.
function AttributeRows({ pairs, onChange }: { pairs: Pair[]; onChange: (p: Pair[]) => void }) {
  return (
    <div className="space-y-2">
      <Label>Custom fields</Label>
      {pairs.map((p, i) => (
        <div key={i} className="flex gap-2">
          <Input
            placeholder="field (e.g. phone)"
            value={p.key}
            onChange={(e) =>
              onChange(pairs.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))
            }
            className="w-1/3"
          />
          <Input
            placeholder="value"
            value={p.value}
            onChange={(e) =>
              onChange(pairs.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))
            }
            className="flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={() => onChange(pairs.filter((_, j) => j !== i))}
            aria-label="Remove field"
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...pairs, { key: "", value: "" }])}
      >
        <Plus className="size-3.5" /> Add field
      </Button>
    </div>
  );
}

export default function AudienceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const router = useRouter();
  // Surface an API error, and when it's the plan/subscriber-limit error, attach a
  // one-tap "Upgrade" action so the free-cap wall has an escape hatch instead of a
  // dead-end toast.
  function toastApiError(err: unknown, fallback: string) {
    const msg = err instanceof Error ? err.message : fallback;
    if (/\blimit\b|\bplan\b|\bupgrade\b|\bsubscribers?\b/i.test(msg)) {
      toast.error(msg, {
        action: { label: "Upgrade", onClick: () => router.push("/billing") },
      });
    } else {
      toast.error(msg);
    }
  }
  const [audience, setAudience] = useState<Audience | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [subscribers, setSubscribers] = useState<Subscriber[] | null>(null);
  // Contacts | Fields | Segments | Topics. Reflected in ?tab= so each view is
  // linkable; read once on mount (client page — window exists only then).
  type TabKey = "contacts" | "fields" | "segments" | "topics";
  const [tab, setTab] = useState<TabKey>("contacts");
  useEffect(() => {
    const t = new URLSearchParams(window.location.search).get("tab");
    if (t === "fields" || t === "segments" || t === "topics") setTab(t);
  }, []);
  function changeTab(next: TabKey) {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "contacts") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }
  // The audience's custom-field registry — drives the Fields tab and the custom
  // columns on the contacts table.
  const [fields, setFields] = useState<AudienceField[] | null>(null);
  // Saved segments — the Segments tab plus the contacts table's segment filter.
  const [segments, setSegments] = useState<SegmentRow[] | null>(null);
  // Which segment the contacts table is narrowed to ("all" = everyone).
  const [segmentFilter, setSegmentFilter] = useState("all");
  // Topics — the Topics tab plus the edit dialog's preference checkboxes.
  const [topics, setTopics] = useState<TopicRow[] | null>(null);
  // The open edit dialog's topic preferences (null = still loading / no topics).
  const [editTopics, setEditTopics] = useState<SubscriberTopic[] | null>(null);
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
  // Custom field key/value pairs for the edit + add dialogs.
  const [editAttrs, setEditAttrs] = useState<Pair[]>([]);
  const [addAttrs, setAddAttrs] = useState<Pair[]>([]);
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
      if (segmentFilter !== "all") params.set("segment", segmentFilter);
      return `/api/audiences/${id}/subscribers?${params}`;
    },
    [id, status, search, segmentFilter],
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

  const loadFields = useCallback(() => {
    api
      .get<{ fields: AudienceField[] }>(`/api/audiences/${id}/fields`)
      .then((res) => setFields(res.fields))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const loadSegments = useCallback(() => {
    api
      .get<{ segments: SegmentRow[] }>(`/api/audiences/${id}/segments`)
      .then((res) => setSegments(res.segments))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const loadTopics = useCallback(() => {
    api
      .get<{ topics: TopicRow[] }>(`/api/audiences/${id}/topics`)
      .then((res) => setTopics(res.topics))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(loadAudience, [loadAudience]);
  useEffect(loadSubscribers, [loadSubscribers]);
  useEffect(loadImports, [loadImports]);
  useEffect(loadFields, [loadFields]);
  useEffect(loadSegments, [loadSegments]);
  useEffect(loadTopics, [loadTopics]);

  // Toast when an import finishes — the upload only said "started", so without
  // this the completion is a silent badge flip on the next poll. On first load we
  // seed the "already announced" set with the existing history so we never toast
  // past imports; after that, a fresh terminal transition is announced once.
  const announcedImports = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (announcedImports.current === null) {
      announcedImports.current = new Set(
        imports.filter((i) => i.status === "completed" || i.status === "failed").map((i) => i.id),
      );
      return;
    }
    for (const imp of imports) {
      if (imp.status !== "completed" && imp.status !== "failed") continue;
      if (announcedImports.current.has(imp.id)) continue;
      announcedImports.current.add(imp.id);
      if (imp.status === "completed") {
        toast.success(
          `Import complete — ${imp.importedRows.toLocaleString()} added` +
            (imp.skippedRows > 0 ? ` · ${imp.skippedRows.toLocaleString()} skipped` : ""),
        );
      } else {
        toast.error("Import failed — see the details below.");
      }
    }
  }, [imports]);

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
      // A CSV with new columns registers them as fields while it processes.
      loadFields();
    }, 2000);
    return () => clearInterval(t);
  }, [hasRunningImport, loadImports, loadSubscribers, loadAudience, loadFields]);

  const onAdd = handleSubmit(async (values) => {
    try {
      await api.post(`/api/audiences/${id}/subscribers`, {
        ...values,
        attributes: attrsFromPairs(addAttrs),
      });
      toast.success("Subscriber added");
      setAddOpen(false);
      reset();
      setAddAttrs([]);
      loadSubscribers();
      loadAudience();
      // A new custom-field key entered here is auto-registered server-side.
      loadFields();
    } catch (err) {
      toastApiError(err, "Failed");
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
      toastApiError(err, "Upload failed");
    }
  }

  // Hand the user a correctly-shaped sample CSV so they can see the expected
  // columns (email required; first_name/last_name optional; extra columns become
  // custom {{merge_tag}} attributes).
  function downloadTemplate() {
    const blob = new Blob([SUBSCRIBER_CSV_TEMPLATE], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "subscribers-template.csv";
    a.click();
    URL.revokeObjectURL(url);
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
    setEditAttrs(pairsFromAttrs(s.attributes));
    // Topic preferences load async; the section renders once they arrive.
    setEditTopics(null);
    if ((topics ?? []).length > 0) {
      api
        .get<{ topics: SubscriberTopic[] }>(`/api/subscribers/${s.id}/topics`)
        .then((res) => setEditTopics(res.topics))
        .catch(() => setEditTopics(null));
    }
  }

  const onEditSub = editForm.handleSubmit(async (values) => {
    if (!editSub) return;
    try {
      await api.patch(`/api/subscribers/${editSub.id}`, {
        ...values,
        attributes: attrsFromPairs(editAttrs),
      });
      if (editTopics && editTopics.length > 0) {
        await api.patch(`/api/subscribers/${editSub.id}/topics`, {
          subscriptions: Object.fromEntries(editTopics.map((t) => [t.id, t.subscribed])),
        });
      }
      toast.success("Subscriber updated");
      setEditSub(null);
      loadSubscribers();
      // A new custom-field key entered here is auto-registered server-side;
      // topic opt-out counts may have shifted too.
      loadFields();
      loadTopics();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update subscriber");
    }
  });

  async function removeSub() {
    if (!confirmSub) return;
    setDeletingSub(true);
    try {
      await api.del(`/api/subscribers/${confirmSub.id}`);
      toast.success("Subscriber deleted");
      setConfirmSub(null);
      loadSubscribers();
      loadAudience();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete subscriber");
    } finally {
      setDeletingSub(false);
    }
  }

  const filtersActive = !!search || status !== "all" || segmentFilter !== "all";
  const shown = subscribers?.length ?? 0;
  const hasMore = shown < total;
  // Whether the audience has anyone to export (any status). `counts` is the
  // per-status breakdown from the audience endpoint.
  const hasSubscribers = Object.values(counts).some((n) => n > 0);

  // Custom-field columns come from the audience's field registry (the Fields
  // tab), capped so the table stays readable. Every value is still editable in
  // the per-row edit dialog, so nothing is hidden — this is the at-a-glance view.
  const attrColumns = useMemo(() => (fields ?? []).slice(0, 4), [fields]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">{audience?.name ?? "…"}</h1>
            {audience && (
              <RowActions label="Audience actions">
                <MenuItem
                  onClick={() => {
                    setRenameValue(audience.name);
                    setRenameOpen(true);
                  }}
                >
                  <Pencil />
                  Rename
                </MenuItem>
                <MenuSeparator />
                <MenuItem variant="destructive" onClick={() => setDeleteAudienceOpen(true)}>
                  <Trash2 />
                  Delete
                </MenuItem>
              </RowActions>
            )}
          </div>
          <p className="text-sm text-muted-foreground tabular-nums">
            {(counts.subscribed ?? 0).toLocaleString()} subscribed
          </p>
        </div>
        {tab === "contacts" && (
        <div className="flex flex-col items-end gap-1.5">
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
            {hasSubscribers && (
              <Button
                variant="outline"
                render={<a href={`/api/audiences/${id}/subscribers/export`} download />}
              >
                Export CSV
              </Button>
            )}
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
                  <AttributeRows pairs={addAttrs} onChange={setAddAttrs} />
                  <Button type="submit" disabled={formState.isSubmitting} className="w-full">
                    {formState.isSubmitting && <OrbitLoader size={16} />}
                    Add
                  </Button>
                </form>
              </DialogContent>
            </Dialog>
          </div>
          <button
            type="button"
            onClick={downloadTemplate}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            CSV needs an <code className="font-mono">email</code> column —{" "}
            <span className="underline underline-offset-2">download a template</span>
          </button>
        </div>
        )}
      </div>

      {/* Contacts | Fields | Segments | Topics — one audience workspace, Resend-style. */}
      <Tabs value={tab} onValueChange={(v) => changeTab(v as typeof tab)}>
        <TabsList>
          <TabsTrigger value="contacts">Contacts</TabsTrigger>
          <TabsTrigger value="fields">Fields</TabsTrigger>
          <TabsTrigger value="segments">Segments</TabsTrigger>
          <TabsTrigger value="topics">Topics</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "fields" && (
        <AudienceFieldsTab audienceId={id} fields={fields} onChanged={loadFields} />
      )}

      {tab === "segments" && (
        <AudienceSegmentsTab
          audienceId={id}
          segments={segments}
          fields={fields}
          onChanged={loadSegments}
        />
      )}

      {tab === "topics" && (
        <AudienceTopicsTab audienceId={id} topics={topics} onChanged={loadTopics} />
      )}

      {tab === "contacts" && (
      <>
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
              <div key={imp.id} className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 text-sm">
                  <span className="truncate">{imp.filename}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-muted-foreground tabular-nums">
                      {imp.status === "processing" && imp.totalRows > 0
                        ? `${imp.importedRows.toLocaleString()} added…`
                        : imp.status === "completed"
                          ? `${imp.importedRows.toLocaleString()} imported · ${imp.skippedRows.toLocaleString()} skipped · ${imp.totalRows.toLocaleString()} total`
                          : null}
                    </span>
                    <Badge variant={statusVariant(imp.status)}>{imp.status}</Badge>
                  </div>
                </div>
                {imp.status === "processing" && imp.totalRows > 0 ? (
                  // Honest progress: how far through the file's rows we are.
                  <Progress
                    value={Math.min(100, Math.round((imp.importedRows / imp.totalRows) * 100))}
                  />
                ) : imp.status === "pending" || imp.status === "processing" ? (
                  // No denominator yet — indeterminate rather than a fake number.
                  <Progress indeterminate />
                ) : null}
                {imp.status === "completed" && imp.skippedRows > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Skipped: {importSkipBreakdown(imp)}
                  </p>
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
          {(segments ?? []).length > 0 && (
            <ListFilter
              value={segmentFilter}
              onChange={setSegmentFilter}
              options={[
                { value: "all", label: "All contacts" },
                ...(segments ?? []).map((s) => ({ value: s.id, label: s.name })),
              ]}
              ariaLabel="Filter by segment"
            />
          )}
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
                  setSegmentFilter("all");
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
                    <code>first_name</code>, <code>last_name</code>, and any extra columns become
                    custom fields) — up to 5,000 rows — or add someone by hand.
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
                    {attrColumns.map((f) => (
                      <TableHead key={f.key}>{f.label}</TableHead>
                    ))}
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
                      {attrColumns.map((f) => (
                        <TableCell key={f.key} className="text-muted-foreground">
                          {s.attributes?.[f.key] || "—"}
                        </TableCell>
                      ))}
                      <TableCell>
                        <Badge variant={statusVariant(s.status)}>{s.status}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDateTime(s.createdAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <RowActions label="Subscriber actions">
                            <MenuItem onClick={() => openEditSub(s)}>
                              <Pencil />
                              Edit
                            </MenuItem>
                            {s.status === "subscribed" && (
                              <MenuItem
                                onClick={async () => {
                                  try {
                                    await api.post(`/api/subscribers/${s.id}/unsubscribe`);
                                    toast.success(`${s.email} unsubscribed`);
                                    loadSubscribers();
                                    loadAudience();
                                  } catch (err) {
                                    toast.error(err instanceof Error ? err.message : "Failed");
                                  }
                                }}
                              >
                                <UserMinus />
                                Unsubscribe
                              </MenuItem>
                            )}
                            <MenuSeparator />
                            <MenuItem variant="destructive" onClick={() => setConfirmSub(s)}>
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
      </>
      )}

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
            <AttributeRows pairs={editAttrs} onChange={setEditAttrs} />
            {editTopics && editTopics.length > 0 && (
              <div className="space-y-2">
                <Label>Topics</Label>
                <div className="space-y-1.5">
                  {editTopics.map((t) => (
                    <label
                      key={t.id}
                      className="flex cursor-pointer items-start gap-2 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="mt-0.5 size-4 accent-primary"
                        checked={t.subscribed}
                        onChange={(e) =>
                          setEditTopics(
                            (cur) =>
                              cur?.map((x) =>
                                x.id === t.id ? { ...x, subscribed: e.target.checked } : x,
                              ) ?? cur,
                          )
                        }
                      />
                      <span>{t.name}</span>
                    </label>
                  ))}
                </div>
              </div>
            )}
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
        title="Delete this subscriber?"
        description={
          <>
            {confirmSub?.email} will be permanently deleted from this audience. To stop
            mailing them without deleting, use Unsubscribe instead.
          </>
        }
        confirmLabel="Delete subscriber"
        busy={deletingSub}
        onConfirm={removeSub}
      />
    </div>
  );
}
