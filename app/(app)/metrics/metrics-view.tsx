"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  BarChart3,
  Eye,
  Flag,
  Inbox,
  MousePointerClick,
  Send,
  Undo2,
  UserMinus,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
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
  RowOpen,
  SortableHead,
  rowLinkProps,
  useListController,
} from "@/components/ui/data-list";
import { Reveal } from "@/components/ui/reveal";
import { SandboxBadge } from "@/components/sandbox-notice";
import { cn } from "@/lib/utils";
import { formatDate, statusLabel, statusVariant } from "@/lib/format";
import type { CampaignMetricCounts, CampaignMetricsRow } from "@/lib/types";

/* ──────────────────────────── rate helpers ──────────────────────────── */

const ZERO: CampaignMetricCounts = {
  recipients: 0,
  sent: 0,
  delivered: 0,
  opened: 0,
  clicked: 0,
  bounced: 0,
  complained: 0,
  unsubscribed: 0,
  failed: 0,
  skipped: 0,
};

function sumCounts(rows: CampaignMetricsRow[]): CampaignMetricCounts {
  return rows.reduce<CampaignMetricCounts>((acc, r) => {
    (Object.keys(acc) as (keyof CampaignMetricCounts)[]).forEach((k) => {
      acc[k] += r.counts[k];
    });
    return acc;
  }, { ...ZERO });
}

const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0);
const pct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;

// Engagement (opens/unsubs) is measured against delivered mail; if the provider
// isn't reporting deliveries, fall back to sent so the rate still means something.
const engagementBase = (c: CampaignMetricCounts): number => c.delivered || c.sent;

type Tone = "good" | "warn" | "bad" | "neutral";

const TONE_BAR: Record<Tone, string> = {
  good: "bg-olive",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  neutral: "bg-foreground/30",
};

const TONE_DOT: Record<Tone, string> = {
  good: "bg-olive",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  neutral: "bg-muted-foreground/40",
};

// SES keeps senders under a 5% bounce / 0.1% complaint rate before review, so
// we flag well below those: amber as a heads-up, red at the danger zone.
const bounceTone = (r: number): Tone => (r >= 0.05 ? "bad" : r >= 0.02 ? "warn" : "good");
const complaintTone = (r: number): Tone => (r >= 0.003 ? "bad" : r >= 0.001 ? "warn" : "good");
const REPUTATION_LABEL: Record<Tone, string> = {
  good: "Healthy",
  warn: "Monitor",
  bad: "At risk",
  neutral: "No data",
};

/* ──────────────────────────── small parts ───────────────────────────── */

function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium">
      <span className={cn("size-2 rounded-full", TONE_DOT[tone])} aria-hidden />
      {label}
    </span>
  );
}

function MetricTile({
  label,
  value,
  caption,
  icon: Icon,
  iconClass,
}: {
  label: string;
  value: number;
  caption?: string;
  icon: LucideIcon;
  iconClass?: string;
}) {
  return (
    <Card>
      <CardContent className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-muted-foreground">{label}</span>
          <Icon className={cn("size-4 shrink-0", iconClass ?? "text-muted-foreground/60")} aria-hidden />
        </div>
        <span className="text-2xl font-semibold tabular-nums">{value.toLocaleString()}</span>
        <span className="min-h-4 text-xs text-muted-foreground tabular-nums">{caption ?? ""}</span>
      </CardContent>
    </Card>
  );
}

// A labelled progress bar. `width` (0–1) drives the fill; `value` (0–1) is the
// number shown on the right (they differ for the funnel, where the bar is a
// share of sent but the caption is the count).
function Bar({
  label,
  width,
  tone,
  right,
}: {
  label: React.ReactNode;
  width: number;
  tone: Tone;
  right: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{right}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", TONE_BAR[tone])}
          style={{ width: `${Math.min(100, Math.max(width * 100, 0))}%` }}
        />
      </div>
    </div>
  );
}

/* ──────────────────────────────── page ──────────────────────────────── */

// Rows come from the server render (./page.tsx). Everything below — the totals,
// the rates, the per-campaign filter — is derived from them client-side, so
// changing the campaign selector stays instant and needs no request.
export function MetricsView({ rows }: { rows: CampaignMetricsRow[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  // Deep link from a sent campaign ("See opens & clicks") pre-selects that
  // campaign via ?campaign=<id>.
  const [campaign, setCampaign] = useState(searchParams.get("campaign") ?? "all");

  // Counts for the chosen scope: all campaigns summed, or the one selected.
  const counts = useMemo<CampaignMetricCounts>(() => {
    if (campaign === "all") return sumCounts(rows);
    return rows.find((r) => r.campaignId === campaign)?.counts ?? sumCounts(rows);
  }, [rows, campaign]);

  const filterOptions = useMemo(
    () => [
      { value: "all", label: "All campaigns" },
      ...rows.map((r) => ({ value: r.campaignId, label: r.name || "Untitled campaign" })),
    ],
    [rows],
  );

  // Per-campaign breakdown table (independent of the scope filter above).
  const table = useListController(rows, {
    searchText: (r) => r.name,
    sortAccessors: {
      name: (r) => r.name.toLowerCase(),
      sent: (r) => r.counts.sent,
      delivered: (r) => r.counts.delivered,
      openRate: (r) => ratio(r.counts.opened, engagementBase(r.counts)),
      clickRate: (r) => ratio(r.counts.clicked, engagementBase(r.counts)),
      bounceRate: (r) => ratio(r.counts.bounced, r.counts.sent),
      unsubscribed: (r) => r.counts.unsubscribed,
      sentAt: (r) => r.sentAt ?? "",
    },
    initialSort: { key: "sentAt", dir: "desc" },
  });

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-3xl">Metrics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Deliverability, reputation and engagement across your sends.
        </p>
      </div>
      {rows.length > 0 && (
        <ListFilter
          value={campaign}
          onChange={setCampaign}
          options={filterOptions}
          ariaLabel="Filter metrics by campaign"
          className="sm:w-56"
        />
      )}
    </div>
  );

  // Truly empty — no campaign has any recipients yet.
  if (rows.length === 0) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <CardContent>
            <ListEmpty
              icon={BarChart3}
              title="Numbers arrive with your first send."
              description="Metrics appear here once you send your first campaign. Sent, delivered, opened, bounced, complained and unsubscribed are all tracked automatically."
              action={<Button render={<Link href="/campaigns/new">New campaign</Link>} />}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  const deliveryRate = ratio(counts.delivered, counts.sent);
  const openRate = ratio(counts.opened, engagementBase(counts));
  const clickRate = ratio(counts.clicked, engagementBase(counts));
  const bounceRate = ratio(counts.bounced, counts.sent);
  const complaintRate = ratio(counts.complained, engagementBase(counts));
  const unsubRate = ratio(counts.unsubscribed, engagementBase(counts));

  const bTone = counts.sent > 0 ? bounceTone(bounceRate) : "neutral";
  const cTone = engagementBase(counts) > 0 ? complaintTone(complaintRate) : "neutral";
  // Overall reputation is the worse of the two signals.
  const order: Tone[] = ["good", "warn", "bad"];
  const repTone: Tone =
    bTone === "neutral" && cTone === "neutral"
      ? "neutral"
      : order[Math.max(order.indexOf(bTone), order.indexOf(cTone))] ?? "good";

  const tiles: { label: string; value: number; caption?: string; icon: LucideIcon; iconClass?: string }[] = [
    { label: "Sent", value: counts.sent, caption: `${counts.recipients.toLocaleString()} recipients`, icon: Send },
    // Sent → Delivered → Opened → Clicked is a funnel, so it's encoded as one
    // hue deepening rather than four unrelated colors: caramel at half strength
    // for an open, full strength for a click, the deepest engagement on the
    // page. That leaves the failure side (amber → clay) reading as a separate
    // family instead of two more entries in a rainbow.
    { label: "Delivered", value: counts.delivered, caption: pct(deliveryRate) + " of sent", icon: Inbox, iconClass: "text-olive/70" },
    { label: "Opened", value: counts.opened, caption: pct(openRate) + " open rate", icon: Eye, iconClass: "text-caramel/60" },
    { label: "Clicked", value: counts.clicked, caption: pct(clickRate) + " click rate", icon: MousePointerClick, iconClass: "text-caramel" },
    { label: "Bounced", value: counts.bounced, caption: pct(bounceRate) + " of sent", icon: Undo2, iconClass: "text-amber-500/70" },
    { label: "Complained", value: counts.complained, caption: pct(complaintRate, 2) + " rate", icon: Flag, iconClass: "text-destructive/70" },
    { label: "Unsubscribed", value: counts.unsubscribed, caption: pct(unsubRate, 2) + " rate", icon: UserMinus },
  ];

  return (
    <div className="space-y-6">
      {header}

      {/* KPI tiles. Reveal *is* the grid rather than a wrapper around it, so
          the seven tiles keep their equal heights. */}
      <Reveal delay={60} className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
        {tiles.map((t) => (
          <MetricTile key={t.label} {...t} />
        ))}
      </Reveal>

      {/* Deliverability funnel */}
      <Reveal delay={120}>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>Deliverability</CardTitle>
            <span className="text-sm text-muted-foreground tabular-nums">
              {pct(deliveryRate)} delivered
            </span>
          </CardHeader>
          <CardContent className="space-y-4">
            <Bar
              label="Sent"
              width={1}
              tone="neutral"
              right={counts.sent.toLocaleString()}
            />
            <Bar
              label="Delivered"
              width={ratio(counts.delivered, counts.sent)}
              tone="good"
              right={`${counts.delivered.toLocaleString()} · ${pct(deliveryRate)}`}
            />
            <Bar
              label="Opened"
              width={ratio(counts.opened, counts.sent)}
              tone="neutral"
              right={`${counts.opened.toLocaleString()} · ${pct(openRate)}`}
            />
            <Bar
              label="Clicked"
              width={ratio(counts.clicked, counts.sent)}
              tone="neutral"
              right={`${counts.clicked.toLocaleString()} · ${pct(clickRate)}`}
            />
            {(counts.bounced > 0 || counts.failed > 0 || counts.skipped > 0) && (
              <p className="pt-1 text-xs text-muted-foreground tabular-nums">
                {counts.bounced.toLocaleString()} bounced · {counts.failed.toLocaleString()} failed ·{" "}
                {counts.skipped.toLocaleString()} skipped (suppressed)
              </p>
            )}
          </CardContent>
        </Card>
      </Reveal>

      <Reveal delay={180} className="grid gap-4 md:grid-cols-2">
        {/* Reputation */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>Reputation</CardTitle>
            <StatusPill tone={repTone} label={REPUTATION_LABEL[repTone]} />
          </CardHeader>
          <CardContent className="space-y-4">
            <Bar
              label={<>Bounce rate <span className="text-muted-foreground/60">· keep under 5%</span></>}
              width={Math.min(1, bounceRate / 0.05)}
              tone={bTone}
              right={pct(bounceRate, 2)}
            />
            <Bar
              label={<>Complaint rate <span className="text-muted-foreground/60">· keep under 0.1%</span></>}
              width={Math.min(1, complaintRate / 0.001)}
              tone={cTone}
              right={pct(complaintRate, 3)}
            />
            <p className="pt-1 text-xs text-muted-foreground">
              Hard bounces and spam complaints are suppressed automatically and can pause sending
              if they spike. Bars are scaled to the provider&apos;s review thresholds.
            </p>
          </CardContent>
        </Card>

        {/* Engagement */}
        <Card>
          <CardHeader>
            <CardTitle>Engagement</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <Bar label="Open rate" width={openRate} tone="neutral" right={pct(openRate)} />
            <Bar label="Click rate" width={clickRate} tone="neutral" right={pct(clickRate)} />
            <Bar label="Unsubscribe rate" width={Math.min(1, unsubRate * 10)} tone="neutral" right={pct(unsubRate, 2)} />
            <p className="pt-1 text-xs text-muted-foreground">
              Opens are measured with a tracking pixel; clicks via tracked links (a click also
              counts as an open). Each is counted once per recipient. Privacy features (e.g. Apple
              Mail Privacy Protection) pre-load images, so open rates can be overstated. Rates are
              against delivered mail.
            </p>
          </CardContent>
        </Card>
      </Reveal>

      {/* Per-campaign breakdown */}
      <Reveal delay={240}>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between gap-2">
            <CardTitle>By campaign</CardTitle>
            {rows.length > 0 && (
              <ListCount shown={table.shown} total={table.total} noun="campaign" />
            )}
          </CardHeader>
          <CardContent className="space-y-4 px-0">
            {rows.length > 3 && (
              <div className="px-6">
                <ListToolbar>
                  <ListSearch
                    value={table.search}
                    onChange={table.setSearch}
                    placeholder="Search campaigns…"
                  />
                </ListToolbar>
              </div>
            )}
            {table.view === null ? null : table.isFilteredEmpty ? (
              <ListNoResults onClear={() => table.setSearch("")} />
            ) : (
              <Table className="[&_td:first-child]:pl-6 [&_td:last-child]:pr-6 [&_th:first-child]:pl-6 [&_th:last-child]:pr-6">
                <TableHeader>
                  <TableRow>
                    <SortableHead label="Campaign" sortKey="name" sort={table.sort} onSort={table.toggleSort} />
                    <SortableHead label="Sent" sortKey="sent" sort={table.sort} onSort={table.toggleSort} align="right" />
                    <SortableHead label="Delivered" sortKey="delivered" sort={table.sort} onSort={table.toggleSort} align="right" />
                    <SortableHead label="Open rate" sortKey="openRate" sort={table.sort} onSort={table.toggleSort} align="right" />
                    <SortableHead label="Click rate" sortKey="clickRate" sort={table.sort} onSort={table.toggleSort} align="right" />
                    <SortableHead label="Bounce rate" sortKey="bounceRate" sort={table.sort} onSort={table.toggleSort} align="right" />
                    <SortableHead label="Unsub" sortKey="unsubscribed" sort={table.sort} onSort={table.toggleSort} align="right" />
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {table.view?.map((r) => {
                    const c = r.counts;
                    const oRate = ratio(c.opened, engagementBase(c));
                    const clRate = ratio(c.clicked, engagementBase(c));
                    const bRate = ratio(c.bounced, c.sent);
                    return (
                      <TableRow
                        key={r.campaignId}
                        {...rowLinkProps(() => router.push(`/campaigns/${r.campaignId}`))}
                      >
                        <TableCell>
                          <div className="flex items-center gap-2">
                            <Link
                              href={`/campaigns/${r.campaignId}`}
                              className="font-medium hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {r.name || "Untitled campaign"}
                            </Link>
                            <Badge variant={statusVariant(r.status)}>{statusLabel(r.status)}</Badge>
                            {r.sandbox && <SandboxBadge />}
                          </div>
                          <span className="text-xs text-muted-foreground">
                            {r.sentAt ? formatDate(r.sentAt) : "Not sent"}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{c.sent.toLocaleString()}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.delivered.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">{pct(oRate)}</TableCell>
                        <TableCell className="text-right tabular-nums">{pct(clRate)}</TableCell>
                        <TableCell className="text-right tabular-nums">
                          <span className={cn(bRate >= 0.05 && "text-destructive", bRate >= 0.02 && bRate < 0.05 && "text-amber-600")}>
                            {pct(bRate, 2)}
                          </span>
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {c.unsubscribed.toLocaleString()}
                        </TableCell>
                        <TableCell className="text-right">
                          <RowOpen href={`/campaigns/${r.campaignId}`} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </Reveal>
    </div>
  );
}
