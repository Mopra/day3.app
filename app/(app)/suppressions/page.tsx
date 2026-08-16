"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
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
  ListError,
  ListFilter,
  ListNoResults,
  ListSearch,
  ListSkeleton,
  ListToolbar,
} from "@/components/ui/data-list";
import { useApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import type { SuppressionRow } from "@/lib/types";

// The stored reasons, in the vocabulary users see. `provider_suppressed` is set by
// the send pipeline when SES itself refuses an address.
const REASON_LABELS: Record<string, string> = {
  unsubscribe: "Unsubscribed",
  hard_bounce: "Bounced",
  complaint: "Marked as spam",
  manual: "Added by hand",
  provider_suppressed: "Blocked by provider",
};

// Reasons a user may pick when adding addresses themselves. The pipeline-owned
// `provider_suppressed` isn't offered — only our own delivery events set that.
const ADDABLE_REASONS = [
  { value: "hard_bounce", label: "Bounced", hint: "Hard-bounced at your old provider" },
  { value: "complaint", label: "Marked as spam", hint: "Filed a spam complaint" },
  { value: "unsubscribe", label: "Unsubscribed", hint: "Opted out" },
  { value: "manual", label: "Added by hand", hint: "Some other reason" },
];

const FILTER_OPTIONS = [
  { value: "all", label: "All reasons" },
  { value: "hard_bounce", label: "Bounced" },
  { value: "complaint", label: "Marked as spam" },
  { value: "unsubscribe", label: "Unsubscribed" },
  { value: "manual", label: "Added by hand" },
  { value: "provider_suppressed", label: "Blocked by provider" },
];

const PAGE = 50;

// A pasted list may arrive comma-, semicolon-, newline- or space-separated —
// accept all of them so "paste the column out of your export" just works.
function splitEmails(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type GlobalEntry = { email: string; reason: string; createdAt: string };

export default function SuppressionsPage() {
  const api = useApi();
  const [rows, setRows] = useState<SuppressionRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [totalSuppressed, setTotalSuppressed] = useState(0);
  const [globalEntry, setGlobalEntry] = useState<GlobalEntry | null>(null);
  const [search, setSearch] = useState("");
  const [reason, setReason] = useState("all");
  const [offset, setOffset] = useState(0);
  const [loadError, setLoadError] = useState(false);

  const [addOpen, setAddOpen] = useState(false);
  const [addText, setAddText] = useState("");
  const [addReason, setAddReason] = useState("hard_bounce");
  const [adding, setAdding] = useState(false);

  const [confirmRemove, setConfirmRemove] = useState<SuppressionRow | null>(null);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(
    (nextOffset = 0, append = false) => {
      setLoadError(false);
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(nextOffset) });
      if (search.trim()) params.set("search", search.trim());
      if (reason !== "all") params.set("reason", reason);
      api
        .get<{
          suppressions: SuppressionRow[];
          total: number;
          totalSuppressed: number;
          globalEntry: GlobalEntry | null;
        }>(`/api/suppressions?${params}`)
        .then((res) => {
          setRows((prev) => (append && prev ? [...prev, ...res.suppressions] : res.suppressions));
          setTotal(res.total);
          setTotalSuppressed(res.totalSuppressed);
          setGlobalEntry(res.globalEntry);
          setOffset(nextOffset);
        })
        .catch((err) => {
          setLoadError(true);
          toast.error(err.message);
        });
    },
    // `api` is a stable client, deliberately out of the dep list (same as every
    // other list page) so a re-render can't re-fire the fetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [search, reason],
  );

  // Debounce the search box; reason changes apply immediately.
  useEffect(() => {
    const t = setTimeout(() => load(0), search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  async function add() {
    const emails = splitEmails(addText);
    if (emails.length === 0) {
      toast.error("Paste at least one email address");
      return;
    }
    setAdding(true);
    try {
      const res = await api.post<{ added: number; alreadySuppressed: number; invalid: number }>(
        "/api/suppressions",
        { emails, reason: addReason },
      );
      const extra: string[] = [];
      if (res.alreadySuppressed > 0) extra.push(`${res.alreadySuppressed} already blocked`);
      if (res.invalid > 0) extra.push(`${res.invalid} not a valid address`);
      toast.success(
        `${res.added.toLocaleString()} address${res.added === 1 ? "" : "es"} blocked` +
          (extra.length ? ` — ${extra.join(", ")}` : ""),
      );
      setAddOpen(false);
      setAddText("");
      load(0);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add those addresses");
    } finally {
      setAdding(false);
    }
  }

  async function remove() {
    if (!confirmRemove) return;
    setRemoving(true);
    try {
      const res = await api.del<{ restoredContacts: number }>(
        `/api/suppressions/${encodeURIComponent(confirmRemove.email)}`,
      );
      toast.success(
        res.restoredContacts > 0
          ? `${confirmRemove.email} can be mailed again — ${res.restoredContacts} contact${res.restoredContacts === 1 ? "" : "s"} restored`
          : `${confirmRemove.email} is no longer blocked`,
      );
      setConfirmRemove(null);
      load(0);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove that address");
    } finally {
      setRemoving(false);
    }
  }

  const filtered = !!search.trim() || reason !== "all";
  const hasMore = rows !== null && rows.length < total;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl sm:text-3xl">Suppressions</h1>
        <Button onClick={() => setAddOpen(true)}>Add addresses</Button>
      </div>

      <p className="max-w-2xl text-sm text-muted-foreground">
        Addresses Day3 will never send to for this account — everyone who unsubscribed,
        hard-bounced, or marked you as spam, plus anything you block by hand. The list applies
        across every audience and every send, campaign or{" "}
        <Link href="/emails" className="underline underline-offset-2 hover:text-foreground">
          transactional
        </Link>
        . Moving in from another platform? Add its bounce and complaint list here{" "}
        <span className="font-medium text-foreground">before</span> importing contacts — those
        addresses are then skipped on the way in automatically.
      </p>

      {rows !== null && (rows.length > 0 || filtered) && (
        <ListToolbar>
          <ListSearch value={search} onChange={setSearch} placeholder="Search by email…" />
          <ListFilter
            value={reason}
            onChange={setReason}
            options={FILTER_OPTIONS}
            ariaLabel="Filter by reason"
          />
          <ListCount
            shown={rows.length}
            total={total}
            noun="address"
            className="ml-auto"
          />
        </ListToolbar>
      )}

      <Card>
        <CardContent>
          {loadError && rows === null ? (
            <ListError onRetry={() => load(0)} />
          ) : rows === null ? (
            <ListSkeleton />
          ) : rows.length === 0 && !filtered ? (
            <ListEmpty
              icon={ShieldCheck}
              title="Nobody is suppressed yet."
              description="Unsubscribes, bounces and spam complaints land here automatically as you send. You can also block addresses yourself — or bring your old provider's bounce list over before you import contacts."
              action={<Button onClick={() => setAddOpen(true)}>Add addresses</Button>}
            />
          ) : rows.length === 0 ? (
            <div className="space-y-4">
              {globalEntry && (
                <div className="rounded-lg border border-border bg-muted/40 p-3 text-sm">
                  <span className="font-medium">{globalEntry.email}</span> is blocked{" "}
                  <span className="font-medium">platform-wide</span> (
                  {REASON_LABELS[globalEntry.reason] ?? globalEntry.reason}), not by your account.
                  Day3 keeps these permanently so someone who opts out can never be re-mailed by a
                  different account. Contact support if you believe it&apos;s wrong.
                </div>
              )}
              <ListNoResults
                onClear={() => {
                  setSearch("");
                  setReason("all");
                }}
              />
            </div>
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Email</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Blocked</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell className="font-medium">{r.email}</TableCell>
                      <TableCell>
                        <Badge variant="secondary">{REASON_LABELS[r.reason] ?? r.reason}</Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(r.createdAt)}
                        {r.source === "app" && " · added by hand"}
                        {r.source?.startsWith("api:") && " · added over the API"}
                      </TableCell>
                      <TableCell className="text-right">
                        <Button
                          variant="ghost"
                          size="sm"
                          className="text-muted-foreground hover:text-destructive"
                          onClick={() => setConfirmRemove(r)}
                        >
                          <Trash2 className="size-4" />
                          Un-suppress
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              {hasMore && (
                <div className="flex justify-center pt-4">
                  <Button variant="outline" onClick={() => load(offset + PAGE, true)}>
                    Load more
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {totalSuppressed > 0 && (
        <p className="text-xs text-muted-foreground">
          {totalSuppressed.toLocaleString()} address{totalSuppressed === 1 ? "" : "es"} suppressed
          in total. Suppression protects your sending reputation — mailing someone who already
          bounced or complained is what gets a domain filtered.
        </p>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Block addresses</DialogTitle>
            <DialogDescription>
              These addresses will never receive mail from your account again — no campaign, no
              transactional send.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="supReason">Reason</Label>
              <Select
                items={Object.fromEntries(ADDABLE_REASONS.map((r) => [r.value, r.label]))}
                value={addReason}
                onValueChange={(v) => v && setAddReason(v)}
              >
                <SelectTrigger id="supReason" aria-label="Reason" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ADDABLE_REASONS.map((r) => (
                    <SelectItem key={r.value} value={r.value}>
                      {r.label} — {r.hint}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Stored with each address so an accidental import is explainable later.
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="supEmails">Email addresses</Label>
              <Textarea
                id="supEmails"
                rows={8}
                placeholder={"bounced@example.com\ncomplained@example.com"}
                value={addText}
                onChange={(e) => setAddText(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                One per line, or paste a comma-separated column straight out of your old
                provider&apos;s export. {splitEmails(addText).length.toLocaleString()} address
                {splitEmails(addText).length === 1 ? "" : "es"} detected. For very large lists, use{" "}
                <Link
                  href="/api-keys"
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  the API
                </Link>
                .
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" onClick={() => setAddOpen(false)}>
                Cancel
              </Button>
              <Button onClick={add} disabled={adding}>
                {adding && <OrbitLoader size={16} />}
                Block addresses
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmRemove}
        onOpenChange={(o) => !o && setConfirmRemove(null)}
        title="Un-suppress this address?"
        description={
          confirmRemove
            ? `${confirmRemove.email} will be able to receive mail from you again, and contacts marked bounced or spam will become mailable. People who unsubscribed themselves stay unsubscribed — only they can opt back in. Mailing an address that hard-bounced again can hurt your sending reputation.`
            : undefined
        }
        confirmLabel="Un-suppress"
        busy={removing}
        onConfirm={remove}
      />
    </div>
  );
}
