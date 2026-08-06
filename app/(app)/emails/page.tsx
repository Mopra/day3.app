"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Send as SendIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
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
  rowLinkProps,
} from "@/components/ui/data-list";
import { ApiPanel } from "@/components/api-panel";
import { SandboxBadge, SandboxBanner } from "@/components/sandbox-notice";
import { buildEmailsPanelContent } from "@/lib/api-docs";
import { useApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { TRANSACTIONAL_BODY_RETENTION_DAYS } from "@/services/transactional";
import type {
  SendingDomain,
  TransactionalEmailDetail,
  TransactionalEmailEvent,
  TransactionalEmailListItem,
} from "@/lib/types";

const PAGE = 50;

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

// Status chips share the delivery pipeline's vocabulary. "sending" is an
// internal blip (a worker claim measured in milliseconds) — shown as Queued.
const STATUS_META: Record<string, { label: string; variant: BadgeVariant; explain: string }> = {
  queued: {
    label: "Queued",
    variant: "outline",
    explain: "Accepted and waiting to be handed to the delivery provider — usually seconds.",
  },
  sending: {
    label: "Queued",
    variant: "outline",
    explain: "Accepted and waiting to be handed to the delivery provider — usually seconds.",
  },
  sent: {
    label: "Sent",
    variant: "default",
    explain: "The delivery provider accepted the email and it is on its way.",
  },
  delivered: {
    label: "Delivered",
    variant: "default",
    explain: "The recipient's mail server accepted the email.",
  },
  bounced: {
    label: "Bounced",
    variant: "destructive",
    explain:
      "The email couldn't be delivered. The bounced address was suppressed and future sends to it are rejected.",
  },
  complained: {
    label: "Marked as spam",
    variant: "destructive",
    explain:
      "The recipient reported the email as spam. The address was suppressed and future sends to it are rejected.",
  },
  failed: {
    label: "Failed",
    variant: "destructive",
    explain: "The email couldn't be sent.",
  },
  suppressed: {
    label: "Suppressed",
    variant: "destructive",
    explain: "The delivery provider's suppression list rejected the address.",
  },
};

const STATUS_FILTERS = [
  { value: "all", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "sent", label: "Sent" },
  { value: "delivered", label: "Delivered" },
  { value: "bounced", label: "Bounced" },
  { value: "complained", label: "Marked as spam" },
  { value: "failed", label: "Failed" },
  { value: "suppressed", label: "Suppressed" },
];

function statusMeta(status: string) {
  return (
    STATUS_META[status] ?? { label: status, variant: "outline" as BadgeVariant, explain: "" }
  );
}

function fullTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

// The event timeline in the drawer, in the pipeline's own words.
const EVENT_LABELS: Record<string, string> = {
  sent: "Handed to the provider",
  delivery: "Delivered",
  bounce: "Bounced",
  complaint: "Marked as spam",
  failed: "Failed",
};

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm break-all">{children}</span>
    </div>
  );
}

export default function EmailsPage() {
  const api = useApi();
  const [emails, setEmails] = useState<TransactionalEmailListItem[] | null>(null);
  const [total, setTotal] = useState(0);
  const [sandbox, setSandbox] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [status, setStatus] = useState("all");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // Verified domains feed the API panel's from-address examples.
  const [domains, setDomains] = useState<SendingDomain[]>([]);

  // Drawer state: the row click fetches the full email (bodies + events).
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<{
    email: TransactionalEmailDetail;
    events: TransactionalEmailEvent[];
  } | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    api
      .get<{ domains: SendingDomain[] }>("/api/domains")
      .then((res) => setDomains(res.domains))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const listUrl = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (status !== "all") params.set("status", status);
      if (search) params.set("search", search);
      return `/api/emails?${params}`;
    },
    [status, search],
  );

  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    api
      .get<{ emails: TransactionalEmailListItem[]; total: number; sandbox: boolean }>(listUrl(0))
      .then((res) => {
        if (cancelled) return;
        setEmails(res.emails);
        setTotal(res.total);
        setSandbox(res.sandbox);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(true);
        toast.error(err.message);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [listUrl, reloadKey]);

  async function loadMore() {
    if (!emails || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.get<{ emails: TransactionalEmailListItem[]; total: number }>(
        listUrl(emails.length),
      );
      setEmails((cur) => [...(cur ?? []), ...res.emails]);
      setTotal(res.total);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load more");
    } finally {
      setLoadingMore(false);
    }
  }

  // Fetch the drawer's detail lazily; the list stays light (no bodies).
  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .get<{ email: TransactionalEmailDetail; events: TransactionalEmailEvent[] }>(
        `/api/emails/${selectedId}`,
      )
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setSelectedId(null);
        toast.error(err instanceof Error ? err.message : "Couldn't load the email");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId]);

  const hasFilters = status !== "all" || search !== "";
  const clearFilters = () => {
    setStatus("all");
    setSearchInput("");
    setSearch("");
  };

  const verifiedDomains = domains
    .filter((d) => d.verificationStatus === "verified" || d.adminOverrideVerified)
    .map((d) => d.domain);

  const email = detail?.email ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-1.5">
            <h1 className="text-2xl font-semibold tracking-tight">Emails</h1>
            <ApiPanel
              build={(origin) =>
                buildEmailsPanelContent({ origin, verifiedDomains, sandbox })
              }
            />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Transactional email sent through the API — password resets, receipts, magic links —
            with per-email delivery status.
          </p>
        </div>
      </div>

      {sandbox && <SandboxBanner surface="transactional" />}

      <ListToolbar>
        <ListSearch
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Search by recipient or subject…"
        />
        <ListFilter
          value={status}
          onChange={setStatus}
          options={STATUS_FILTERS}
          ariaLabel="Filter by status"
        />
        {emails && emails.length > 0 && (
          <ListCount shown={emails.length} total={total} noun="email" className="ml-auto" />
        )}
      </ListToolbar>

      <Card>
        <CardContent>
          {loadError && !emails ? (
            <ListError onRetry={() => setReloadKey((k) => k + 1)} />
          ) : !emails ? (
            <ListSkeleton rows={8} />
          ) : emails.length === 0 && !hasFilters ? (
            <ListEmpty
              icon={SendIcon}
              title="No emails sent yet"
              description="Send transactional email from your own code with one POST /v1/emails call — grab an API key, then use the </> button above for copy-paste snippets. Every send shows up here with its delivery status."
              action={<Button render={<Link href="/api-keys">Get an API key</Link>} />}
            />
          ) : emails.length === 0 ? (
            <ListNoResults onClear={clearFilters} />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-36">When</TableHead>
                    <TableHead className="w-36">Status</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead className="hidden lg:table-cell">From</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {emails.map((e) => {
                    const meta = statusMeta(e.status);
                    return (
                      <TableRow key={e.id} {...rowLinkProps(() => setSelectedId(e.id))}>
                        <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                          {formatDateTime(e.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <Badge variant={meta.variant}>{meta.label}</Badge>
                            {e.sandbox && <SandboxBadge />}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-56 truncate font-medium">
                          {e.to[0]}
                          {e.to.length > 1 && (
                            <span className="text-muted-foreground"> +{e.to.length - 1}</span>
                          )}
                        </TableCell>
                        <TableCell className="max-w-72 truncate">{e.subject}</TableCell>
                        <TableCell className="hidden max-w-56 truncate text-muted-foreground lg:table-cell">
                          {e.fromEmail}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {emails.length < total && (
                <div className="flex justify-center pt-4">
                  <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore ? "Loading…" : "Load more"}
                  </Button>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Email detail drawer: status story first, content preview behind it. */}
      <Sheet open={!!selectedId} onOpenChange={(open) => !open && setSelectedId(null)}>
        <SheetContent side="right" className="overflow-y-auto p-6 sm:max-w-lg">
          {!email ? (
            <div className="pt-8">
              <ListSkeleton rows={6} />
            </div>
          ) : (
            <div className="space-y-5">
              <SheetHeader className="p-0 pr-8">
                <SheetTitle className="flex items-center gap-2">
                  <Badge variant={statusMeta(email.status).variant}>
                    {statusMeta(email.status).label}
                  </Badge>
                  {email.sandbox && <SandboxBadge />}
                </SheetTitle>
                <SheetDescription>{statusMeta(email.status).explain}</SheetDescription>
              </SheetHeader>

              <div className="space-y-3">
                <DetailRow label="Subject">{email.subject}</DetailRow>
                <DetailRow label="From">
                  {email.fromName ? `${email.fromName} <${email.fromEmail}>` : email.fromEmail}
                </DetailRow>
                <DetailRow label="To">{email.to.join(", ")}</DetailRow>
                {email.replyTo && <DetailRow label="Reply-To">{email.replyTo}</DetailRow>}
                {email.error && (
                  <DetailRow label="Error">
                    <span className="text-destructive">{email.error}</span>
                  </DetailRow>
                )}
                {email.tags && Object.keys(email.tags).length > 0 && (
                  <DetailRow label="Tags">
                    <span className="flex flex-wrap gap-1.5">
                      {Object.entries(email.tags).map(([k, v]) => (
                        <Badge key={k} variant="outline" className="font-mono text-xs">
                          {k}={v}
                        </Badge>
                      ))}
                    </span>
                  </DetailRow>
                )}
                <DetailRow label="Email id">
                  <span className="font-mono text-xs">{email.id}</span>
                </DetailRow>
                {email.providerMessageId && (
                  <DetailRow label="Provider message ID">
                    <span className="font-mono text-xs">{email.providerMessageId}</span>
                  </DetailRow>
                )}
              </div>

              {/* Delivery timeline — accepted first, then the provider events. */}
              <div className="space-y-2">
                <span className="text-xs text-muted-foreground">Timeline</span>
                <div className="space-y-1.5 rounded-lg border border-border p-3">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span>Accepted via API</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {fullTimestamp(email.createdAt)}
                    </span>
                  </div>
                  {detail?.events.map((ev) => (
                    <div key={ev.id} className="flex items-baseline justify-between gap-3 text-sm">
                      <span>{EVENT_LABELS[ev.eventType] ?? ev.eventType}</span>
                      <span className="text-xs text-muted-foreground tabular-nums">
                        {fullTimestamp(ev.createdAt)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Content: rendered preview for HTML, plain text otherwise. Bodies
                  are pruned after the retention window — say so instead of
                  showing an empty email. */}
              <div className="space-y-2">
                <span className="text-xs text-muted-foreground">Content</span>
                {email.bodyPrunedAt ? (
                  <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
                    The content of this email has expired — bodies are kept for{" "}
                    {TRANSACTIONAL_BODY_RETENTION_DAYS} days.
                  </p>
                ) : email.htmlBody ? (
                  <iframe
                    sandbox=""
                    srcDoc={email.htmlBody}
                    title="Email preview"
                    className="h-72 w-full rounded-lg border border-border bg-white"
                  />
                ) : email.textBody ? (
                  <pre className="max-h-72 overflow-auto rounded-lg border border-border p-3 text-xs leading-relaxed whitespace-pre-wrap">
                    {email.textBody}
                  </pre>
                ) : null}
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
