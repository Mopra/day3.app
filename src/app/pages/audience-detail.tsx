import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useApi } from "../lib/api";
import { formatDateTime, statusVariant } from "../lib/format";
import type { Audience, ImportRow, Subscriber } from "../lib/types";

const STATUS_FILTERS = [
  { value: "all", label: "All statuses" },
  { value: "subscribed", label: "Subscribed" },
  { value: "unsubscribed", label: "Unsubscribed" },
  { value: "bounced", label: "Bounced" },
  { value: "complained", label: "Complained" },
  { value: "suppressed", label: "Suppressed" },
];

type AddForm = { email: string; firstName?: string; lastName?: string };

export function AudienceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const [audience, setAudience] = useState<Audience | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [subscribers, setSubscribers] = useState<Subscriber[] | null>(null);
  const [total, setTotal] = useState(0);
  const [imports, setImports] = useState<ImportRow[]>([]);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState("all");
  const [addOpen, setAddOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
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

  const loadSubscribers = useCallback(() => {
    const params = new URLSearchParams({ limit: "50" });
    if (status !== "all") params.set("status", status);
    if (search) params.set("search", search);
    api
      .get<{ subscribers: Subscriber[]; total: number }>(
        `/api/audiences/${id}/subscribers?${params}`,
      )
      .then((res) => {
        setSubscribers(res.subscribers);
        setTotal(res.total);
      })
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, status, search]);

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

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{audience?.name ?? "…"}</h1>
          <p className="text-sm text-muted-foreground">
            {counts.subscribed ?? 0} subscribed · {total} shown
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

      {imports.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Imports</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {imports.slice(0, 3).map((imp) => (
              <div key={imp.id} className="space-y-1">
                <div className="flex items-center justify-between text-sm">
                  <span className="truncate">{imp.filename}</span>
                  <span className="flex items-center gap-2 text-muted-foreground">
                    {imp.status === "completed" &&
                      `${imp.importedRows} imported, ${imp.skippedRows} skipped`}
                    {imp.status === "failed" && (imp.error ?? "failed")}
                    <Badge variant={statusVariant(imp.status)}>{imp.status}</Badge>
                  </span>
                </div>
                {(imp.status === "pending" || imp.status === "processing") && (
                  <Progress value={imp.status === "pending" ? 5 : 50} />
                )}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2">
        <Input
          placeholder="Search by email…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="max-w-xs"
        />
        <Select
          items={STATUS_FILTERS}
          value={status}
          onValueChange={(v) => setStatus(v as string)}
        >
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STATUS_FILTERS.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                {s.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent>
          {subscribers === null ? (
            <Skeleton className="h-24 w-full" />
          ) : subscribers.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No subscribers match. Import a CSV with an <code>email</code> column (optional{" "}
              <code>first_name</code>, <code>last_name</code>) — up to 5,000 rows.
            </p>
          ) : (
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
                    <TableCell>{formatDateTime(s.createdAt)}</TableCell>
                    <TableCell className="text-right">
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
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
