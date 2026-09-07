"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Activity as ActivityIcon, Send as SendIcon } from "lucide-react";
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
import type { ActivitySend, ActivitySendEvent, ActivitySource, SendingDomain } from "@/lib/types";

// One server page (the endpoint caps a request at 100); "Load more" appends.
const PAGE = 50;

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

// Everything the UI needs to present a send's status: the badge, and the
// plain-language explanation troubleshooting users actually read. Technical
// payloads stay behind "Technical details" in the drawer.
const STATUS_META: Record<string, { label: string; variant: BadgeVariant; explain: string }> = {
  queued: {
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
    explain: "The email couldn't be delivered to this address.",
  },
  complained: {
    label: "Marked as spam",
    variant: "destructive",
    explain:
      "The recipient reported the email as spam. The address was suppressed and won't be emailed again.",
  },
  unsubscribed: {
    label: "Unsubscribed",
    variant: "outline",
    explain: "The recipient unsubscribed using the link in the email.",
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
  skipped: {
    label: "Skipped",
    variant: "outline",
    explain:
      "This recipient was left out at send time — suppressed, unsubscribed, or outside the campaign's segment by then.",
  },
};

const STATUS_FILTERS = [
  { value: "all", label: "All statuses" },
  { value: "queued", label: "Queued" },
  { value: "sent", label: "Sent" },
  { value: "delivered", label: "Delivered" },
  { value: "opened", label: "Opened" },
  { value: "clicked", label: "Clicked" },
  { value: "bounced", label: "Bounced" },
  { value: "complained", label: "Marked as spam" },
  { value: "unsubscribed", label: "Unsubscribed" },
  { value: "failed", label: "Failed" },
  { value: "suppressed", label: "Suppressed" },
  { value: "skipped", label: "Skipped" },
];

const SOURCE_FILTERS = [
  { value: "all", label: "All sources" },
  { value: "campaign", label: "Campaigns" },
  { value: "automation", label: "Automations" },
  { value: "api", label: "API" },
];

const SOURCE_LABELS: Record<ActivitySource, string> = {
  campaign: "Campaign",
  automation: "Automation",
  api: "API",
};

function statusMeta(status: string) {
  return STATUS_META[status] ?? { label: status, variant: "outline" as BadgeVariant, explain: "" };
}

// The event timeline in the drawer, in the pipeline's own words.
const EVENT_LABELS: Record<string, string> = {
  sent: "Handed to the provider",
  delivery: "Delivered",
  open: "Opened",
  click: "Clicked",
  bounce: "Bounced",
  complaint: "Marked as spam",
  unsubscribe: "Unsubscribed",
  failed: "Failed",
  provider_error: "Provider error",
};

type Payload = Record<string, unknown>;

function parsePayload(raw: string | null): Payload | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Payload) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const rec = (v: unknown): Payload => (typeof v === "object" && v !== null ? (v as Payload) : {});

// The one-line, human-readable specifics of an event — the failure reason, the
// clicked URL, the bounce diagnostic — shown under its timeline entry.
function eventDetail(e: ActivitySendEvent): string | null {
  const payload = parsePayload(e.payloadJson);
  switch (e.eventType) {
    case "failed":
    case "provider_error":
      return str(payload?.error) ?? null;
    case "click":
      return str(payload?.url) ?? null;
    case "bounce": {
      // SES/SNS bounce notification: bounce.bounceType ("Permanent"/"Transient")
      // and a per-recipient SMTP diagnostic when the receiving server gave one.
      const bounce = rec(payload?.bounce);
      const type = str(bounce.bounceType);
      const recipients = Array.isArray(bounce.bouncedRecipients) ? bounce.bouncedRecipients : [];
      const diagnostic = str(rec(recipients[0]).diagnosticCode);
      const kind =
        type === "Permanent" ? "Permanent bounce" : type === "Transient" ? "Temporary bounce" : type;
      return [kind, diagnostic].filter(Boolean).join(": ") || null;
    }
    case "complaint": {
      const feedback = str(rec(payload?.complaint).complaintFeedbackType);
      return feedback ? `Complaint type: ${feedback}` : null;
    }
    default:
      return null;
  }
}

// Bounces deserve a more specific explanation than the generic one when the
// bounce event says whether it's permanent (address gone for good) or temporary.
function sendExplain(send: ActivitySend, events: ActivitySendEvent[]): string {
  if (send.status === "bounced") {
    const bounce = events.find((e) => e.eventType === "bounce");
    const type = str(rec(parsePayload(bounce?.payloadJson ?? null)?.bounce).bounceType);
    if (type === "Permanent") {
      return "The email couldn't be delivered: the address doesn't exist or permanently rejects mail. It was suppressed and won't be emailed again.";
    }
    if (type === "Transient") {
      return "The email couldn't be delivered right now, a temporary problem such as a full mailbox. The address stays on your list.";
    }
  }
  return statusMeta(send.status).explain;
}

// What the row was: the campaign or automation it belongs to, or the API
// message's subject.
function sendTitle(s: ActivitySend): string {
  if (s.source === "api") return s.subject ?? "";
  if (s.source === "automation") return s.automationName ?? "Automation";
  return s.campaignName ?? "Untitled campaign";
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

function prettyPayload(raw: string | null): string | null {
  if (!raw) return null;
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

// One labelled row in the drawer's fact list.
function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm break-all">{children}</span>
    </div>
  );
}

type SendDetail = {
  send: ActivitySend;
  events: ActivitySendEvent[];
  email: {
    replyTo: string | null;
    fromName: string | null;
    to: string[];
    tags: Record<string, string> | null;
    htmlBody: string | null;
    textBody: string | null;
    bodyPrunedAt: string | null;
  } | null;
};

type ListResponse = { sends: ActivitySend[]; total: number; sandbox: boolean };

function isSource(v: string | null): v is ActivitySource {
  return v === "campaign" || v === "automation" || v === "api";
}

export default function ActivityPage() {
  const api = useApi();
  const searchParams = useSearchParams();
  const [sends, setSends] = useState<ActivitySend[] | null>(null);
  const [total, setTotal] = useState(0);
  const [sandbox, setSandbox] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // Deep links: a sent campaign's "Troubleshoot a recipient" pre-filters to that
  // campaign via ?campaignId=; the old /emails page redirects here as ?source=api.
  const [source, setSource] = useState(() => {
    const s = searchParams.get("source");
    return isSource(s) ? s : "all";
  });
  const [status, setStatus] = useState(() => {
    const s = searchParams.get("status");
    return s && STATUS_FILTERS.some((f) => f.value === s) ? s : "all";
  });
  const [campaign, setCampaign] = useState(searchParams.get("campaignId") ?? "all");
  const [campaignOptions, setCampaignOptions] = useState([
    { value: "all", label: "All campaigns" },
  ]);
  // `searchInput` is what the user types; `search` is the debounced value we
  // actually query with, so we don't hit the API on every keystroke.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [loadError, setLoadError] = useState(false);
  // Bumped by the retry button to re-run the first-page effect after a failure.
  const [reloadKey, setReloadKey] = useState(0);
  // Verified domains feed the API panel's from-address examples.
  const [domains, setDomains] = useState<SendingDomain[]>([]);

  // Drawer state: the row click fetches the send's timeline (and, for an API
  // send, its content).
  const [selected, setSelected] = useState<ActivitySend | null>(null);
  const [detail, setDetail] = useState<SendDetail | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 250);
    return () => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    api
      .get<{ campaigns: { id: string; name: string }[] }>("/api/campaigns")
      .then((res) =>
        setCampaignOptions([
          { value: "all", label: "All campaigns" },
          ...res.campaigns.map((c) => ({ value: c.id, label: c.name || "Untitled campaign" })),
        ]),
      )
      .catch(() => {});
    api
      .get<{ domains: SendingDomain[] }>("/api/domains")
      .then((res) => setDomains(res.domains))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const listUrl = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (source !== "all") params.set("source", source);
      if (status !== "all") params.set("status", status);
      if (campaign !== "all") params.set("campaignId", campaign);
      if (search) params.set("search", search);
      return `/api/activity?${params}`;
    },
    [source, status, campaign, search],
  );

  // (Re)load the first page on mount and whenever a filter changes.
  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    api
      .get<ListResponse>(listUrl(0))
      .then((res) => {
        if (cancelled) return;
        setSends(res.sends);
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
    if (!sends || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.get<ListResponse>(listUrl(sends.length));
      setSends((cur) => [...(cur ?? []), ...res.sends]);
      setTotal(res.total);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load more");
    } finally {
      setLoadingMore(false);
    }
  }

  // Fetch the drawer's detail lazily; the list stays light (no events, no bodies).
  useEffect(() => {
    if (!selected) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    api
      .get<SendDetail>(`/api/activity/${selected.id}?source=${selected.source}`)
      .then((res) => {
        if (!cancelled) setDetail(res);
      })
      .catch((err) => {
        if (cancelled) return;
        setSelected(null);
        toast.error(err instanceof Error ? err.message : "Couldn't load the email");
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const hasFilters = source !== "all" || status !== "all" || campaign !== "all" || search !== "";
  const clearFilters = () => {
    setSource("all");
    setStatus("all");
    setCampaign("all");
    setSearchInput("");
    setSearch("");
  };

  // Picking a campaign is a campaign-side question; drop a contradicting source.
  const changeSource = (next: string) => {
    setSource(next);
    if (next !== "all" && next !== "campaign") setCampaign("all");
  };

  const verifiedDomains = domains
    .filter((d) => d.verificationStatus === "verified" || d.adminOverrideVerified)
    .map((d) => d.domain);

  const send = detail?.send ?? selected;
  const payloads = useMemo(
    () =>
      (detail?.events ?? [])
        .map((e) => ({ id: e.id, label: EVENT_LABELS[e.eventType] ?? e.eventType, json: prettyPayload(e.payloadJson) }))
        .filter((p) => p.json),
    [detail],
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-1.5">
          <h1 className="font-display text-2xl sm:text-3xl">Activity</h1>
          <ApiPanel
            build={(origin) => buildEmailsPanelContent({ origin, verifiedDomains, sandbox })}
          />
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Every email you sent, from campaigns, automations and your own code, with its delivery
          status. Open one to see what happened to it and why.
        </p>
      </div>

      {sandbox && source === "api" && <SandboxBanner surface="transactional" />}

      <ListToolbar>
        <ListSearch
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Search by recipient email…"
        />
        <ListFilter
          value={source}
          onChange={changeSource}
          options={SOURCE_FILTERS}
          ariaLabel="Filter by source"
        />
        <ListFilter
          value={status}
          onChange={setStatus}
          options={STATUS_FILTERS}
          ariaLabel="Filter by status"
        />
        {(source === "all" || source === "campaign") && (
          <ListFilter
            value={campaign}
            onChange={setCampaign}
            options={campaignOptions}
            ariaLabel="Filter by campaign"
            className="sm:w-56"
          />
        )}
        {sends && sends.length > 0 && (
          <ListCount shown={sends.length} total={total} noun="email" className="ml-auto" />
        )}
      </ListToolbar>

      <Card>
        <CardContent>
          {loadError && !sends ? (
            <ListError onRetry={() => setReloadKey((k) => k + 1)} />
          ) : !sends ? (
            <ListSkeleton rows={8} />
          ) : sends.length === 0 && source === "api" && status === "all" && search === "" ? (
            <ListEmpty
              icon={SendIcon}
              title="Your app hasn't sent anything yet."
              description="Send transactional email from your own code with one POST /v1/emails call. Grab an API key, then use the </> button above for copy-paste snippets. Every send shows up here with its delivery status."
              action={<Button render={<Link href="/api-keys">Get an API key</Link>} />}
            />
          ) : sends.length === 0 && !hasFilters ? (
            <ListEmpty
              icon={ActivityIcon}
              title="Every email you send lands here."
              description="Campaign, automation and API sends all show up here with their status: sent, delivered, opened, clicked, bounced, marked as spam, unsubscribed or failed."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  <Button render={<Link href="/campaigns/new">New campaign</Link>} />
                  <Button variant="outline" render={<Link href="/api-keys">Send from your code</Link>} />
                </div>
              }
            />
          ) : sends.length === 0 ? (
            <ListNoResults onClear={clearFilters} />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-36">When</TableHead>
                    <TableHead className="w-40">Status</TableHead>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead className="hidden w-28 lg:table-cell">Source</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {sends.map((s) => {
                    const meta = statusMeta(s.status);
                    // Engagement is a fact about a delivered email, not a status
                    // of its own: shown beside the badge rather than replacing it.
                    const engagement = s.clickedAt ? "Clicked" : s.openedAt ? "Opened" : null;
                    return (
                      <TableRow key={`${s.source}:${s.id}`} {...rowLinkProps(() => setSelected(s))}>
                        <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                          {formatDateTime(s.createdAt)}
                        </TableCell>
                        <TableCell>
                          <div className="flex items-center gap-1.5">
                            <Badge variant={meta.variant}>{meta.label}</Badge>
                            {engagement && (
                              <span className="text-xs text-muted-foreground">· {engagement}</span>
                            )}
                            {s.sandbox && <SandboxBadge />}
                          </div>
                        </TableCell>
                        <TableCell className="max-w-56 truncate font-medium">
                          {s.email || "—"}
                          {s.recipientCount > 1 && (
                            <span className="text-muted-foreground"> +{s.recipientCount - 1}</span>
                          )}
                        </TableCell>
                        <TableCell className="max-w-72 truncate text-muted-foreground">
                          {sendTitle(s)}
                        </TableCell>
                        <TableCell className="hidden text-muted-foreground lg:table-cell">
                          {SOURCE_LABELS[s.source]}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {sends.length < total && (
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

      {/* Send drawer: status story first, then the timeline, then (for an API
          send) the content, with the raw provider payloads behind "Technical
          details". */}
      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right" className="overflow-y-auto p-4 sm:max-w-lg sm:p-6">
          {send && (
            <div className="space-y-5">
              <SheetHeader className="p-0 pr-8">
                <SheetTitle className="flex items-center gap-2">
                  <Badge variant={statusMeta(send.status).variant}>
                    {statusMeta(send.status).label}
                  </Badge>
                  {send.sandbox && <SandboxBadge />}
                </SheetTitle>
                <SheetDescription>{sendExplain(send, detail?.events ?? [])}</SheetDescription>
              </SheetHeader>

              <div className="space-y-3">
                {send.source === "api" ? (
                  <>
                    <DetailRow label="Subject">{send.subject}</DetailRow>
                    <DetailRow label="From">
                      {detail?.email?.fromName
                        ? `${detail.email.fromName} <${send.fromEmail}>`
                        : send.fromEmail}
                    </DetailRow>
                    <DetailRow label="To">{detail?.email?.to.join(", ") ?? send.email}</DetailRow>
                    {detail?.email?.replyTo && (
                      <DetailRow label="Reply-To">{detail.email.replyTo}</DetailRow>
                    )}
                  </>
                ) : (
                  <>
                    <DetailRow label="Recipient">{send.email}</DetailRow>
                    {send.source === "campaign" && (
                      <DetailRow label="Campaign">
                        {send.campaignId ? (
                          <Link
                            href={`/campaigns/${send.campaignId}`}
                            className="underline underline-offset-2 hover:text-foreground"
                          >
                            {send.campaignName ?? "View campaign"}
                          </Link>
                        ) : (
                          "—"
                        )}
                      </DetailRow>
                    )}
                    {send.source === "automation" && (
                      <DetailRow label="Automation">{send.automationName ?? "—"}</DetailRow>
                    )}
                  </>
                )}
                {send.error && (
                  <DetailRow label="Error">
                    <span className="text-destructive">{send.error}</span>
                  </DetailRow>
                )}
                {detail?.email?.tags && Object.keys(detail.email.tags).length > 0 && (
                  <DetailRow label="Tags">
                    <span className="flex flex-wrap gap-1.5">
                      {Object.entries(detail.email.tags).map(([k, v]) => (
                        <Badge key={k} variant="outline" className="font-mono text-xs">
                          {k}={v}
                        </Badge>
                      ))}
                    </span>
                  </DetailRow>
                )}
                {send.source === "api" && (
                  <DetailRow label="Email id">
                    <span className="font-mono text-xs">{send.id}</span>
                  </DetailRow>
                )}
                {send.providerMessageId && (
                  <DetailRow label="Provider message ID">
                    <span className="font-mono text-xs">{send.providerMessageId}</span>
                  </DetailRow>
                )}
              </div>

              {/* Timeline: accepted first, then everything the pipeline and the
                  provider reported, each with its one-line specifics. */}
              <div className="space-y-2">
                <span className="text-xs text-muted-foreground">Timeline</span>
                <div className="space-y-2 rounded-lg border border-border p-3">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span>{send.source === "api" ? "Accepted via API" : "Queued"}</span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {fullTimestamp(send.createdAt)}
                    </span>
                  </div>
                  {!detail ? (
                    <ListSkeleton rows={2} />
                  ) : (
                    detail.events.map((ev) => {
                      const line = eventDetail(ev);
                      return (
                        <div key={ev.id} className="space-y-0.5">
                          <div className="flex items-baseline justify-between gap-3 text-sm">
                            <span>{EVENT_LABELS[ev.eventType] ?? ev.eventType}</span>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {fullTimestamp(ev.createdAt)}
                            </span>
                          </div>
                          {line && (
                            <p className="text-xs break-all text-muted-foreground">{line}</p>
                          )}
                        </div>
                      );
                    })
                  )}
                </div>
              </div>

              {/* Content (API sends only): rendered preview for HTML, plain text
                  otherwise. Bodies are pruned after the retention window; say so
                  instead of showing an empty email. */}
              {detail?.email && (
                <div className="space-y-2">
                  <span className="text-xs text-muted-foreground">Content</span>
                  {detail.email.bodyPrunedAt ? (
                    <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
                      The content of this email has expired. Bodies are kept for{" "}
                      {TRANSACTIONAL_BODY_RETENTION_DAYS} days.
                    </p>
                  ) : detail.email.htmlBody ? (
                    <iframe
                      sandbox=""
                      srcDoc={detail.email.htmlBody}
                      title="Email preview"
                      className="h-72 w-full rounded-lg border border-border bg-white"
                    />
                  ) : detail.email.textBody ? (
                    <pre className="max-h-72 overflow-auto rounded-lg border border-border p-3 text-xs leading-relaxed whitespace-pre-wrap">
                      {detail.email.textBody}
                    </pre>
                  ) : null}
                </div>
              )}

              {payloads.length > 0 && (
                <details className="rounded-lg border border-border">
                  <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground select-none">
                    Technical details
                  </summary>
                  <div className="divide-y divide-border border-t border-border">
                    {payloads.map((p) => (
                      <div key={p.id} className="p-3">
                        <p className="mb-1 text-xs text-muted-foreground">{p.label}</p>
                        <pre className="overflow-x-auto text-xs leading-relaxed">{p.json}</pre>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
