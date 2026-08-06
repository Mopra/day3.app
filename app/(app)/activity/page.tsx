"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Activity as ActivityIcon } from "lucide-react";
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
import { useApi } from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import type { ActivityEvent } from "@/lib/types";

// One server page (the endpoint caps a request at 100); "Load more" appends.
const PAGE = 50;

type BadgeVariant = "default" | "secondary" | "destructive" | "outline";

// Everything the UI needs to present an event type: the badge, and the
// plain-language explanation troubleshooting users actually read. Technical
// payloads stay behind "Technical details" in the drawer.
const EVENT_META: Record<string, { label: string; variant: BadgeVariant; explain: string }> = {
  sent: {
    label: "Sent",
    variant: "default",
    explain: "The email was handed to the delivery provider and is on its way.",
  },
  delivery: {
    label: "Delivered",
    variant: "default",
    explain: "The recipient's mail server accepted the email.",
  },
  open: {
    label: "Opened",
    variant: "secondary",
    explain: "The recipient opened the email. Only the first open is recorded.",
  },
  click: {
    label: "Clicked",
    variant: "secondary",
    explain: "The recipient clicked a link in the email.",
  },
  bounce: {
    label: "Bounced",
    variant: "destructive",
    explain: "The email couldn't be delivered to this address.",
  },
  complaint: {
    label: "Marked as spam",
    variant: "destructive",
    explain:
      "The recipient reported the email as spam. The address was suppressed and won't be emailed again.",
  },
  unsubscribe: {
    label: "Unsubscribed",
    variant: "outline",
    explain: "The recipient unsubscribed using the link in the email.",
  },
  failed: {
    label: "Failed",
    variant: "destructive",
    explain: "The email couldn't be sent.",
  },
  provider_error: {
    label: "Provider error",
    variant: "destructive",
    explain: "The delivery provider reported an error for this email.",
  },
};

const TYPE_FILTERS = [
  { value: "all", label: "All events" },
  ...Object.entries(EVENT_META).map(([value, meta]) => ({ value, label: meta.label })),
];

function eventMeta(type: string) {
  return EVENT_META[type] ?? { label: type, variant: "outline" as BadgeVariant, explain: "" };
}

type Payload = Record<string, unknown>;

function parsePayload(e: ActivityEvent): Payload | null {
  if (!e.payloadJson) return null;
  try {
    const parsed = JSON.parse(e.payloadJson);
    return typeof parsed === "object" && parsed !== null ? (parsed as Payload) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const rec = (v: unknown): Payload => (typeof v === "object" && v !== null ? (v as Payload) : {});

// The one-line, human-readable specifics of an event — the failure reason, the
// clicked URL, the bounce diagnostic. Shown in the list's Detail column and
// featured in the drawer.
function eventDetail(e: ActivityEvent): string | null {
  const payload = parsePayload(e);
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
      return [kind, diagnostic].filter(Boolean).join(" — ") || null;
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
// payload says whether it's permanent (address gone for good) or temporary.
function eventExplain(e: ActivityEvent): string {
  if (e.eventType === "bounce") {
    const type = str(rec(parsePayload(e)?.bounce).bounceType);
    if (type === "Permanent") {
      return "The email couldn't be delivered — the address doesn't exist or permanently rejects mail. It was suppressed and won't be emailed again.";
    }
    if (type === "Transient") {
      return "The email couldn't be delivered right now — a temporary problem such as a full mailbox. The address stays on your list.";
    }
  }
  return eventMeta(e.eventType).explain;
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

function prettyPayload(e: ActivityEvent): string | null {
  if (!e.payloadJson) return null;
  try {
    return JSON.stringify(JSON.parse(e.payloadJson), null, 2);
  } catch {
    return e.payloadJson;
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

export default function ActivityPage() {
  const api = useApi();
  const searchParams = useSearchParams();
  const [events, setEvents] = useState<ActivityEvent[] | null>(null);
  const [total, setTotal] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [type, setType] = useState("all");
  // Deep link from a sent campaign ("Troubleshoot a recipient") pre-filters to
  // that campaign via ?campaignId=<id>.
  const [campaign, setCampaign] = useState(searchParams.get("campaignId") ?? "all");
  const [campaignOptions, setCampaignOptions] = useState([
    { value: "all", label: "All campaigns" },
  ]);
  // `searchInput` is what the user types; `search` is the debounced value we
  // actually query with, so we don't hit the API on every keystroke.
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<ActivityEvent | null>(null);
  const [loadError, setLoadError] = useState(false);
  // Bumped by the retry button to re-run the first-page effect after a failure.
  const [reloadKey, setReloadKey] = useState(0);

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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activityUrl = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (type !== "all") params.set("type", type);
      if (campaign !== "all") params.set("campaignId", campaign);
      if (search) params.set("search", search);
      return `/api/activity?${params}`;
    },
    [type, campaign, search],
  );

  // (Re)load the first page on mount and whenever a filter changes.
  useEffect(() => {
    let cancelled = false;
    setLoadError(false);
    api
      .get<{ events: ActivityEvent[]; total: number }>(activityUrl(0))
      .then((res) => {
        if (cancelled) return;
        setEvents(res.events);
        setTotal(res.total);
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
  }, [activityUrl, reloadKey]);

  async function loadMore() {
    if (!events || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.get<{ events: ActivityEvent[]; total: number }>(
        activityUrl(events.length),
      );
      setEvents((cur) => [...(cur ?? []), ...res.events]);
      setTotal(res.total);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load more");
    } finally {
      setLoadingMore(false);
    }
  }

  const hasFilters = type !== "all" || campaign !== "all" || search !== "";
  const clearFilters = () => {
    setType("all");
    setCampaign("all");
    setSearchInput("");
    setSearch("");
  };

  const selectedDetail = useMemo(() => (selected ? eventDetail(selected) : null), [selected]);
  const selectedPayload = useMemo(() => (selected ? prettyPayload(selected) : null), [selected]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl">Activity</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every email event — sends, deliveries, opens, clicks, bounces and failures — in one
          place, for status and troubleshooting.
        </p>
      </div>

      <ListToolbar>
        <ListSearch
          value={searchInput}
          onChange={setSearchInput}
          placeholder="Search by recipient email…"
        />
        <ListFilter
          value={type}
          onChange={setType}
          options={TYPE_FILTERS}
          ariaLabel="Filter by event type"
        />
        <ListFilter
          value={campaign}
          onChange={setCampaign}
          options={campaignOptions}
          ariaLabel="Filter by campaign"
          className="sm:w-56"
        />
        {events && events.length > 0 && (
          <ListCount shown={events.length} total={total} noun="event" className="ml-auto" />
        )}
      </ListToolbar>

      <Card>
        <CardContent>
          {loadError && !events ? (
            <ListError onRetry={() => setReloadKey((k) => k + 1)} />
          ) : !events ? (
            <ListSkeleton rows={8} />
          ) : events.length === 0 && !hasFilters ? (
            <ListEmpty
              icon={ActivityIcon}
              title="Every email event lands here."
              description="Every email event — sent, delivered, opened, clicked, bounced, complained, unsubscribed and failed — shows up here once you send your first campaign."
              action={<Button render={<Link href="/campaigns/new">New campaign</Link>} />}
            />
          ) : events.length === 0 ? (
            <ListNoResults onClear={clearFilters} />
          ) : (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-36">When</TableHead>
                    <TableHead className="w-36">Event</TableHead>
                    <TableHead>Recipient</TableHead>
                    <TableHead>Campaign</TableHead>
                    <TableHead className="hidden lg:table-cell">Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e) => {
                    const meta = eventMeta(e.eventType);
                    const detail = eventDetail(e);
                    return (
                      <TableRow key={e.id} {...rowLinkProps(() => setSelected(e))}>
                        <TableCell className="whitespace-nowrap text-muted-foreground tabular-nums">
                          {formatDateTime(e.createdAt)}
                        </TableCell>
                        <TableCell>
                          <Badge variant={meta.variant}>{meta.label}</Badge>
                        </TableCell>
                        <TableCell className="max-w-56 truncate font-medium">
                          {e.email ?? "—"}
                        </TableCell>
                        <TableCell className="max-w-48 truncate text-muted-foreground">
                          {e.campaignName ?? "—"}
                        </TableCell>
                        <TableCell className="hidden max-w-72 truncate text-muted-foreground lg:table-cell">
                          {detail ?? ""}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
              {events.length < total && (
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

      {/* Event detail drawer: plain-language explanation first, raw provider
          payload behind "Technical details". */}
      <Sheet open={!!selected} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right" className="overflow-y-auto p-6 sm:max-w-md">
          {selected && (
            <div className="space-y-5">
              <SheetHeader className="p-0">
                <SheetTitle className="flex items-center gap-2">
                  <Badge variant={eventMeta(selected.eventType).variant}>
                    {eventMeta(selected.eventType).label}
                  </Badge>
                </SheetTitle>
                <SheetDescription>{eventExplain(selected)}</SheetDescription>
              </SheetHeader>

              <div className="space-y-3">
                <DetailRow label="Recipient">{selected.email ?? "—"}</DetailRow>
                <DetailRow label="Time">{fullTimestamp(selected.createdAt)}</DetailRow>
                <DetailRow label="Campaign">
                  {selected.campaignId ? (
                    <Link
                      href={`/campaigns/${selected.campaignId}`}
                      className="underline underline-offset-2 hover:text-foreground"
                    >
                      {selected.campaignName ?? "View campaign"}
                    </Link>
                  ) : (
                    "—"
                  )}
                </DetailRow>
                {selectedDetail && <DetailRow label="Detail">{selectedDetail}</DetailRow>}
                {selected.providerMessageId && (
                  <DetailRow label="Provider message ID">
                    <span className="font-mono text-xs">{selected.providerMessageId}</span>
                  </DetailRow>
                )}
              </div>

              {selectedPayload && (
                <details className="rounded-lg border border-border">
                  <summary className="cursor-pointer px-3 py-2 text-sm text-muted-foreground select-none">
                    Technical details
                  </summary>
                  <pre className="overflow-x-auto border-t border-border p-3 text-xs leading-relaxed">
                    {selectedPayload}
                  </pre>
                </details>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
