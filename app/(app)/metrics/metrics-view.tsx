"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useRouter } from "next/navigation";
import {
  BarChart3,
  Eye,
  Flag,
  Inbox,
  MousePointerClick,
  Send,
  ServerCog,
  ShieldAlert,
  Undo2,
  UserMinus,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { CampaignStatusBadge } from "@/components/ui/campaign-status-badge";
import { AutomationStatusBadge } from "@/components/ui/status-badge";
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
import { formatDate } from "@/lib/format";
import type {
  AutomationMetricsRow,
  CampaignMetricCounts,
  CampaignMetricsRow,
  ReputationSummary,
  TransactionalMetrics,
} from "@/lib/types";

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

function sumCounts(rows: { counts: CampaignMetricCounts }[]): CampaignMetricCounts {
  return rows.reduce<CampaignMetricCounts>((acc, r) => {
    (Object.keys(acc) as (keyof CampaignMetricCounts)[]).forEach((k) => {
      acc[k] += r.counts[k];
    });
    return acc;
  }, { ...ZERO });
}

const ratio = (num: number, den: number): number => (den > 0 ? num / den : 0);
const pct = (v: number, digits = 1): string => `${(v * 100).toFixed(digits)}%`;
const n = (v: number): string => v.toLocaleString();

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

const TONE_TEXT: Record<Tone, string> = {
  good: "",
  warn: "text-amber-600",
  bad: "text-destructive",
  neutral: "",
};

/* ────────────────────────────── scope ───────────────────────────────── */

// What the page is looking at. "all" is every send the account made; the other
// three narrow to one producer. This replaced a campaign-only dropdown, which is
// why the page had quietly become campaign-shaped: the filter could not express
// any other question.
type Scope = "all" | "campaign" | "automation" | "api";

const SCOPE_OPTIONS = [
  { value: "all", label: "All sends" },
  { value: "campaign", label: "Campaigns" },
  { value: "automation", label: "Automations" },
  { value: "api", label: "Transactional (API)" },
];

const SOURCE_LABEL: Record<string, string> = {
  campaign: "Campaigns",
  automation: "Automations",
  api: "Transactional (API)",
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

// A labelled progress bar. `width` (0–1) drives the fill; `right` is what's shown
// on the right (they differ for the funnel, where the bar is a share of sent but
// the caption carries the count too).
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

/* ─────────────────────────── reputation card ────────────────────────── */

// The one card on this page that is NOT scope-filtered, because reputation is
// not a per-campaign fact: AWS judges one bounce rate for the whole SES account,
// and it is the account that gets paused. It shows exactly what
// services/health.ts computes — same trailing window, same thresholds, same
// address-level counting — so that a user who reads "Healthy" here is reading
// the number that decides whether their mail keeps flowing.
function ReputationCard({ rep }: { rep: ReputationSummary }) {
  const t = rep.thresholds;
  const enforceable = rep.attempted >= t.minAttempted;

  // Per-bar tone mirrors the enforcement rule exactly: a pause needs the rate
  // AND an absolute count behind it, so a rate over the line with two bounces
  // behind it is a warning here, not a red bar — the same judgement the guard
  // makes. See MIN_BOUNCED_FOR_PAUSE in services/health.ts.
  const bounceTone: Tone =
    !enforceable || rep.attempted === 0
      ? "neutral"
      : rep.bounceRate >= t.bouncePause && rep.bounced >= t.minBounced
        ? "bad"
        : rep.bounceRate >= t.bounceWarn
          ? "warn"
          : "good";
  const complaintTone: Tone =
    !enforceable || rep.attempted === 0
      ? "neutral"
      : rep.complaintRate >= t.complaintPause && rep.complained >= t.minComplained
        ? "bad"
        : rep.complaintRate >= t.complaintWarn
          ? "warn"
          : "good";

  const pill: { tone: Tone; label: string } =
    rep.attempted === 0
      ? { tone: "neutral", label: "No sends yet" }
      : !enforceable
        ? { tone: "neutral", label: "Too little volume to judge" }
        : rep.status === "paused"
          ? { tone: "bad", label: "Sending paused" }
          : rep.status === "warning"
            ? { tone: "warn", label: "Monitor" }
            : { tone: "good", label: "Healthy" };

  const sources = rep.bySource.filter((s) => s.attempted > 0);

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
        <div>
          <CardTitle>Reputation</CardTitle>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Every send, whichever made it · last {rep.windowDays} days
          </p>
        </div>
        <StatusPill tone={pill.tone} label={pill.label} />
      </CardHeader>
      <CardContent className="space-y-4">
        <Bar
          label={
            <>
              Bounce rate{" "}
              <span className="text-muted-foreground/60">
                · pauses at {pct(t.bouncePause, 0)}
              </span>
            </>
          }
          width={Math.min(1, rep.bounceRate / t.bouncePause)}
          tone={bounceTone}
          right={`${pct(rep.bounceRate, 2)} · ${n(rep.bounced)} of ${n(rep.attempted)}`}
        />
        <Bar
          label={
            <>
              Complaint rate{" "}
              <span className="text-muted-foreground/60">
                · pauses at {pct(t.complaintPause, 2)}
              </span>
            </>
          }
          width={Math.min(1, rep.complaintRate / t.complaintPause)}
          tone={complaintTone}
          right={`${pct(rep.complaintRate, 3)} · ${n(rep.complained)} of ${n(rep.attempted)}`}
        />

        {/* Which stream is responsible. The fix differs completely by source — a
            bad campaign audience gets cleaned, a bad API integration gets fixed
            in the customer's own code — so the split is the actionable half. */}
        {sources.length > 1 && (
          <div className="rounded-lg border border-border/60">
            <Table className="[&_td]:py-2 [&_th]:py-2 [&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
              <TableHeader>
                <TableRow>
                  <TableHead>By source</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead className="text-right">Bounced</TableHead>
                  <TableHead className="text-right">Complaints</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sources.map((s) => {
                  const b = ratio(s.bounced, s.attempted);
                  const c = ratio(s.complained, s.attempted);
                  return (
                    <TableRow key={s.source} className="hover:bg-transparent">
                      <TableCell className="font-medium">{SOURCE_LABEL[s.source]}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(s.attempted)}</TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          b >= t.bouncePause && "text-destructive",
                          b >= t.bounceWarn && b < t.bouncePause && "text-amber-600",
                        )}
                      >
                        {pct(b, 2)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "text-right tabular-nums",
                          c >= t.complaintPause && "text-destructive",
                          c >= t.complaintWarn && c < t.complaintPause && "text-amber-600",
                        )}
                      >
                        {pct(c, 3)}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </div>
        )}

        {rep.status === "paused" && rep.reason && (
          <p className="flex items-start gap-2 rounded-lg bg-destructive/10 p-3 text-xs text-destructive">
            <ShieldAlert className="mt-px size-4 shrink-0" aria-hidden />
            <span>
              {rep.reason}. Clean up the list behind the source above, then contact support to
              re-enable sending.
            </span>
          </p>
        )}

        <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
          {enforceable ? (
            <>
              Sending pauses automatically above {pct(t.bouncePause, 0)} bounces (and at least{" "}
              {t.minBounced} of them) or {pct(t.complaintPause, 2)} complaints (at least{" "}
              {t.minComplained}). Both halves are required, so a single bad address can&apos;t
              stop your mail.
            </>
          ) : (
            <>
              Rates need at least {t.minAttempted} sends in the window before they mean anything,
              so nothing is enforced below that. Hard bounces and spam complaints are suppressed
              automatically either way.
            </>
          )}{" "}
          Campaigns, automations and API sends all count toward the same reputation — AWS sees one
          sender.
        </p>
      </CardContent>
    </Card>
  );
}

/* ────────────────────────── marketing sections ──────────────────────── */

function MarketingTiles({ counts }: { counts: CampaignMetricCounts }) {
  const deliveryRate = ratio(counts.delivered, counts.sent);
  const openRate = ratio(counts.opened, engagementBase(counts));
  const clickRate = ratio(counts.clicked, engagementBase(counts));
  const bounceRate = ratio(counts.bounced, counts.sent);
  const complaintRate = ratio(counts.complained, engagementBase(counts));
  const unsubRate = ratio(counts.unsubscribed, engagementBase(counts));

  const tiles: { label: string; value: number; caption?: string; icon: LucideIcon; iconClass?: string }[] = [
    { label: "Sent", value: counts.sent, caption: `${n(counts.recipients)} recipients`, icon: Send },
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
    <Reveal delay={60} className="grid grid-cols-2 gap-4 sm:grid-cols-4 lg:grid-cols-7">
      {tiles.map((t) => (
        <MetricTile key={t.label} {...t} />
      ))}
    </Reveal>
  );
}

function MarketingDetail({ counts }: { counts: CampaignMetricCounts }) {
  const deliveryRate = ratio(counts.delivered, counts.sent);
  const openRate = ratio(counts.opened, engagementBase(counts));
  const clickRate = ratio(counts.clicked, engagementBase(counts));
  const unsubRate = ratio(counts.unsubscribed, engagementBase(counts));

  return (
    <Reveal delay={180} className="grid gap-4 md:grid-cols-2">
      {/* Deliverability funnel */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>Deliverability</CardTitle>
          <span className="text-sm text-muted-foreground tabular-nums">
            {pct(deliveryRate)} delivered
          </span>
        </CardHeader>
        <CardContent className="space-y-4">
          <Bar label="Sent" width={1} tone="neutral" right={n(counts.sent)} />
          <Bar
            label="Delivered"
            width={ratio(counts.delivered, counts.sent)}
            tone="good"
            right={`${n(counts.delivered)} · ${pct(deliveryRate)}`}
          />
          <Bar
            label="Opened"
            width={ratio(counts.opened, counts.sent)}
            tone="neutral"
            right={`${n(counts.opened)} · ${pct(openRate)}`}
          />
          <Bar
            label="Clicked"
            width={ratio(counts.clicked, counts.sent)}
            tone="neutral"
            right={`${n(counts.clicked)} · ${pct(clickRate)}`}
          />
          {(counts.bounced > 0 || counts.failed > 0 || counts.skipped > 0) && (
            <p className="pt-1 text-xs text-muted-foreground tabular-nums">
              {n(counts.bounced)} bounced · {n(counts.failed)} failed · {n(counts.skipped)} skipped
              (suppressed)
            </p>
          )}
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
          <Bar
            label="Unsubscribe rate"
            width={Math.min(1, unsubRate * 10)}
            tone="neutral"
            right={pct(unsubRate, 2)}
          />
          <p className="pt-1 text-xs leading-relaxed text-muted-foreground">
            Opens are measured with a tracking pixel; clicks via tracked links (a click also counts
            as an open). Each is counted once per recipient. Privacy features (e.g. Apple Mail
            Privacy Protection) pre-load images, so open rates can be overstated. Rates are against
            delivered mail, and cover campaigns and automations only — transactional mail carries
            no tracking.
          </p>
        </CardContent>
      </Card>
    </Reveal>
  );
}

/* ──────────────────────── transactional sections ────────────────────── */

// API mail gets its own numbers rather than a place in the funnel above,
// because the funnel does not apply to it: there is no tracking pixel on a
// password reset, no tracked links in a receipt and no unsubscribe on either,
// so opens/clicks/unsubscribes are not zero here — they don't exist. What it has
// instead is `failed` and `suppressed`, mail that never left the building, which
// for an integration is the number that actually matters.
function TransactionalTiles({ tx }: { tx: TransactionalMetrics }) {
  const c = tx.totals;
  const deliveryRate = ratio(c.delivered, c.sent);
  const bounceRate = ratio(c.bounced, c.sent);
  const complaintRate = ratio(c.complained, c.sent);
  const failRate = ratio(c.failed + c.suppressed, c.emails);

  const tiles: { label: string; value: number; caption?: string; icon: LucideIcon; iconClass?: string }[] = [
    {
      label: "Sent",
      value: c.sent,
      caption: `${n(c.messages)} API ${c.messages === 1 ? "call" : "calls"}`,
      icon: Send,
    },
    { label: "Delivered", value: c.delivered, caption: pct(deliveryRate) + " of sent", icon: Inbox, iconClass: "text-olive/70" },
    { label: "Bounced", value: c.bounced, caption: pct(bounceRate, 2) + " of sent", icon: Undo2, iconClass: "text-amber-500/70" },
    { label: "Complained", value: c.complained, caption: pct(complaintRate, 3) + " rate", icon: Flag, iconClass: "text-destructive/70" },
    {
      label: "Never sent",
      value: c.failed + c.suppressed,
      caption: `${pct(failRate, 2)} of requests`,
      icon: ServerCog,
      iconClass: c.failed + c.suppressed > 0 ? "text-destructive/70" : undefined,
    },
    { label: "Queued", value: c.queued, caption: c.queued > 0 ? "waiting to send" : "", icon: BarChart3 },
  ];

  return (
    <Reveal delay={60} className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
      {tiles.map((t) => (
        <MetricTile key={t.label} {...t} />
      ))}
    </Reveal>
  );
}

function TransactionalDelivery({ tx }: { tx: TransactionalMetrics }) {
  const c = tx.totals;
  const deliveryRate = ratio(c.delivered, c.sent);
  return (
    <Reveal delay={180}>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle>Delivery</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Counted in addresses — one API call can address up to 50 people
            </p>
          </div>
          <span className="text-sm text-muted-foreground tabular-nums">
            {pct(deliveryRate)} delivered
          </span>
        </CardHeader>
        <CardContent className="space-y-4">
          <Bar label="Requested" width={1} tone="neutral" right={n(c.emails)} />
          <Bar label="Sent" width={ratio(c.sent, c.emails)} tone="neutral" right={n(c.sent)} />
          <Bar
            label="Delivered"
            width={ratio(c.delivered, c.emails)}
            tone="good"
            right={`${n(c.delivered)} · ${pct(deliveryRate)}`}
          />
          <Bar
            label="Bounced"
            width={ratio(c.bounced, c.emails)}
            tone={c.bounced > 0 ? "warn" : "neutral"}
            right={`${n(c.bounced)} · ${pct(ratio(c.bounced, c.sent), 2)}`}
          />
          {(c.failed > 0 || c.suppressed > 0) && (
            <p className="rounded-lg bg-muted/60 p-3 text-xs leading-relaxed text-muted-foreground">
              <span className="font-medium text-foreground">
                {n(c.failed + c.suppressed)} never left.
              </span>{" "}
              {n(c.failed)} failed (an unverified From domain, a rejected sender, or a provider
              error) and {n(c.suppressed)} were blocked by your suppression list. Unlike a bounce,
              these usually mean the integration needs fixing rather than the address.{" "}
              <Link href="/activity?source=api&status=failed" className="underline">
                See which
              </Link>
              .
            </p>
          )}
        </CardContent>
      </Card>
    </Reveal>
  );
}

function TransactionalSenders({ tx }: { tx: TransactionalMetrics }) {
  const table = useListController(tx.senders, {
    searchText: (r) => r.fromEmail,
    sortAccessors: {
      fromEmail: (r) => r.fromEmail.toLowerCase(),
      emails: (r) => r.counts.emails,
      delivered: (r) => r.counts.delivered,
      bounceRate: (r) => ratio(r.counts.bounced, r.counts.sent),
      neverSent: (r) => r.counts.failed + r.counts.suppressed,
      lastSentAt: (r) => r.lastSentAt ?? "",
    },
    initialSort: { key: "emails", dir: "desc" },
  });

  return (
    <Reveal delay={240}>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <div>
            <CardTitle>By sender</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Grouped by the From address, which is usually one per feature
            </p>
          </div>
          <ListCount shown={table.shown} total={table.total} noun="sender" />
        </CardHeader>
        <CardContent className="space-y-4 px-0">
          {tx.senders.length > 3 && (
            <div className="px-6">
              <ListToolbar>
                <ListSearch
                  value={table.search}
                  onChange={table.setSearch}
                  placeholder="Search senders…"
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
                  <SortableHead label="From" sortKey="fromEmail" sort={table.sort} onSort={table.toggleSort} />
                  <SortableHead label="Emails" sortKey="emails" sort={table.sort} onSort={table.toggleSort} align="right" />
                  <SortableHead label="Delivered" sortKey="delivered" sort={table.sort} onSort={table.toggleSort} align="right" />
                  <SortableHead label="Bounce rate" sortKey="bounceRate" sort={table.sort} onSort={table.toggleSort} align="right" />
                  <SortableHead label="Never sent" sortKey="neverSent" sort={table.sort} onSort={table.toggleSort} align="right" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {table.view?.map((r) => {
                  const c = r.counts;
                  const bRate = ratio(c.bounced, c.sent);
                  const never = c.failed + c.suppressed;
                  return (
                    <TableRow key={r.fromEmail} className="hover:bg-transparent">
                      <TableCell>
                        <div className="font-medium">{r.fromEmail}</div>
                        <span className="text-xs text-muted-foreground">
                          {r.lastSentAt ? `Last sent ${formatDate(r.lastSentAt)}` : "Never sent"} ·{" "}
                          {n(c.messages)} {c.messages === 1 ? "call" : "calls"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{n(c.emails)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(c.delivered)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className={cn(bRate >= 0.05 && "text-destructive", bRate >= 0.02 && bRate < 0.05 && "text-amber-600")}>
                          {pct(bRate, 2)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className={cn(never > 0 && "text-destructive")}>{n(never)}</span>
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
  );
}

// The compact version, shown on "All sends" so API volume is visible without
// scrolling past a second full set of tiles. The detail lives one scope away.
function TransactionalSummary({ tx, onOpen }: { tx: TransactionalMetrics; onOpen: () => void }) {
  const c = tx.totals;
  const never = c.failed + c.suppressed;
  const stats: { label: string; value: string; tone?: Tone }[] = [
    { label: "Emails", value: n(c.emails) },
    { label: "Delivered", value: pct(ratio(c.delivered, c.sent)) },
    { label: "Bounce rate", value: pct(ratio(c.bounced, c.sent), 2) },
    { label: "Never sent", value: n(never), tone: never > 0 ? "bad" : undefined },
  ];
  return (
    <Reveal delay={210}>
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <div>
            <CardTitle>Transactional (API)</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Mail your app sent through POST /v1/emails · no opens or clicks, by design
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onOpen}>
            View detail
          </Button>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {stats.map((s) => (
              <div key={s.label} className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">{s.label}</span>
                <span className={cn("text-xl font-semibold tabular-nums", s.tone && TONE_TEXT[s.tone])}>
                  {s.value}
                </span>
              </div>
            ))}
          </div>
        </CardContent>
      </Card>
    </Reveal>
  );
}

/* ─────────────────────────── breakdown tables ───────────────────────── */

function CampaignTable({ rows }: { rows: CampaignMetricsRow[] }) {
  const router = useRouter();
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

  return (
    <Reveal delay={240}>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>By campaign</CardTitle>
          <ListCount shown={table.shown} total={table.total} noun="campaign" />
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
                          <CampaignStatusBadge status={r.status} />
                          {r.sandbox && <SandboxBadge />}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {r.sentAt ? formatDate(r.sentAt) : "Not sent"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{n(c.sent)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(c.delivered)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(oRate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(clRate)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className={cn(bRate >= 0.05 && "text-destructive", bRate >= 0.02 && bRate < 0.05 && "text-amber-600")}>
                          {pct(bRate, 2)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{n(c.unsubscribed)}</TableCell>
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
  );
}

function AutomationTable({ rows }: { rows: AutomationMetricsRow[] }) {
  const router = useRouter();
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
      lastSentAt: (r) => r.lastSentAt ?? "",
    },
    initialSort: { key: "lastSentAt", dir: "desc" },
  });

  return (
    <Reveal delay={300}>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>By automation</CardTitle>
          <ListCount shown={table.shown} total={table.total} noun="automation" />
        </CardHeader>
        <CardContent className="space-y-4 px-0">
          {rows.length > 3 && (
            <div className="px-6">
              <ListToolbar>
                <ListSearch
                  value={table.search}
                  onChange={table.setSearch}
                  placeholder="Search automations…"
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
                  <SortableHead label="Automation" sortKey="name" sort={table.sort} onSort={table.toggleSort} />
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
                      key={r.automationId}
                      {...rowLinkProps(() => router.push(`/automations/${r.automationId}`))}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <Link
                            href={`/automations/${r.automationId}`}
                            className="font-medium hover:underline"
                            onClick={(e) => e.stopPropagation()}
                          >
                            {r.name || "Untitled automation"}
                          </Link>
                          <AutomationStatusBadge status={r.status} />
                          {r.sandbox && <SandboxBadge />}
                        </div>
                        <span className="text-xs text-muted-foreground">
                          {r.lastSentAt ? `Last sent ${formatDate(r.lastSentAt)}` : "Not sent yet"}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{n(c.sent)}</TableCell>
                      <TableCell className="text-right tabular-nums">{n(c.delivered)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(oRate)}</TableCell>
                      <TableCell className="text-right tabular-nums">{pct(clRate)}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        <span className={cn(bRate >= 0.05 && "text-destructive", bRate >= 0.02 && bRate < 0.05 && "text-amber-600")}>
                          {pct(bRate, 2)}
                        </span>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{n(c.unsubscribed)}</TableCell>
                      <TableCell className="text-right">
                        <RowOpen href={`/automations/${r.automationId}`} />
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
  );
}

/* ──────────────────────────────── page ──────────────────────────────── */

// Everything below is derived from the server render (./page.tsx) client-side,
// so changing scope stays instant and needs no request.
export function MetricsView({
  campaigns,
  automations,
  transactional,
  reputation,
}: {
  campaigns: CampaignMetricsRow[];
  automations: AutomationMetricsRow[];
  transactional: TransactionalMetrics;
  reputation: ReputationSummary;
}) {
  const searchParams = useSearchParams();

  // Deep links: a sent campaign's "See opens & clicks" arrives as
  // ?campaign=<id>, an automation as ?automation=<id>, and ?source=api opens
  // the transactional view.
  //
  // Scope and entity are ONE piece of state, not two synced by an effect. They
  // are not independent — a campaign id means nothing to the automation view, so
  // changing scope must clear the entity in the same commit. As two states with
  // a reset effect, the initial deep-linked ?campaign=<id> was wiped the moment
  // the effect first ran.
  const [filter, setFilter] = useState<{ scope: Scope; entity: string }>(() => {
    const campaign = searchParams.get("campaign");
    if (campaign) return { scope: "campaign", entity: campaign };
    const automation = searchParams.get("automation");
    if (automation) return { scope: "automation", entity: automation };
    if (searchParams.get("source") === "api") return { scope: "api", entity: "all" };
    return { scope: "all", entity: "all" };
  });
  const { scope, entity } = filter;
  const setScope = (next: Scope) => setFilter({ scope: next, entity: "all" });
  const setEntity = (next: string) => setFilter((f) => ({ ...f, entity: next }));

  const scopedRows = useMemo<{ counts: CampaignMetricCounts }[]>(() => {
    if (scope === "campaign") {
      return entity === "all" ? campaigns : campaigns.filter((r) => r.campaignId === entity);
    }
    if (scope === "automation") {
      return entity === "all" ? automations : automations.filter((r) => r.automationId === entity);
    }
    return [...campaigns, ...automations];
  }, [scope, entity, campaigns, automations]);

  const counts = useMemo(() => sumCounts(scopedRows), [scopedRows]);

  const entityOptions = useMemo(() => {
    if (scope === "campaign") {
      return [
        { value: "all", label: "All campaigns" },
        ...campaigns.map((r) => ({ value: r.campaignId, label: r.name || "Untitled campaign" })),
      ];
    }
    if (scope === "automation") {
      return [
        { value: "all", label: "All automations" },
        ...automations.map((r) => ({
          value: r.automationId,
          label: r.name || "Untitled automation",
        })),
      ];
    }
    return [];
  }, [scope, campaigns, automations]);

  const hasAnySend =
    campaigns.length > 0 || automations.length > 0 || transactional.totals.messages > 0;

  const header = (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl">Metrics</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Deliverability, reputation and engagement across every send.
        </p>
      </div>
      {hasAnySend && (
        <div className="flex flex-wrap items-center gap-2">
          <ListFilter
            value={scope}
            onChange={(v) => setScope(v as Scope)}
            options={SCOPE_OPTIONS}
            ariaLabel="Filter metrics by source"
            className="sm:w-52"
          />
          {entityOptions.length > 1 && (
            <ListFilter
              value={entity}
              onChange={setEntity}
              options={entityOptions}
              ariaLabel={scope === "campaign" ? "Filter by campaign" : "Filter by automation"}
              className="sm:w-56"
            />
          )}
        </div>
      )}
    </div>
  );

  // Truly empty — nothing has been sent by anything.
  if (!hasAnySend) {
    return (
      <div className="space-y-6">
        {header}
        <Card>
          <CardContent>
            <ListEmpty
              icon={BarChart3}
              title="Numbers arrive with your first send."
              description="Metrics appear here once you send your first campaign, publish an automation, or call the email API. Sent, delivered, opened, bounced, complained and unsubscribed are all tracked automatically."
              action={<Button render={<Link href="/campaigns/new">New campaign</Link>} />}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  if (scope === "api") {
    return (
      <div className="space-y-6">
        {header}
        {transactional.totals.messages === 0 ? (
          <Card>
            <CardContent>
              <ListEmpty
                icon={ServerCog}
                title="No transactional mail yet."
                description="Receipts, password resets and other one-to-one mail your app sends through POST /v1/emails show up here. They carry no tracking pixel and no unsubscribe, so you get delivery and reputation rather than opens and clicks."
                action={<Button render={<Link href="/api-keys">Create an API key</Link>} />}
              />
            </CardContent>
          </Card>
        ) : (
          <>
            <TransactionalTiles tx={transactional} />
            <Reveal delay={120}>
              <ReputationCard rep={reputation} />
            </Reveal>
            <TransactionalDelivery tx={transactional} />
            <TransactionalSenders tx={transactional} />
          </>
        )}
      </div>
    );
  }

  const scopeIsEmpty = scopedRows.length === 0;

  return (
    <div className="space-y-6">
      {header}

      {scopeIsEmpty ? (
        <Card>
          <CardContent>
            <ListEmpty
              icon={scope === "automation" ? Workflow : BarChart3}
              title={
                scope === "automation"
                  ? "No automation has sent anything yet."
                  : "No campaign has sent anything yet."
              }
              description={
                scope === "automation"
                  ? "Publish an automation and its sends will be measured here alongside your campaigns."
                  : "Send your first campaign and its numbers will appear here."
              }
              action={
                <Button
                  render={
                    <Link href={scope === "automation" ? "/automations" : "/campaigns/new"}>
                      {scope === "automation" ? "Go to automations" : "New campaign"}
                    </Link>
                  }
                />
              }
            />
          </CardContent>
        </Card>
      ) : (
        <MarketingTiles counts={counts} />
      )}

      <Reveal delay={120}>
        <ReputationCard rep={reputation} />
      </Reveal>

      {!scopeIsEmpty && <MarketingDetail counts={counts} />}

      {scope === "all" && transactional.totals.messages > 0 && (
        <TransactionalSummary tx={transactional} onOpen={() => setScope("api")} />
      )}

      {(scope === "all" || scope === "campaign") && campaigns.length > 0 && (
        <CampaignTable rows={campaigns} />
      )}
      {(scope === "all" || scope === "automation") && automations.length > 0 && (
        <AutomationTable rows={automations} />
      )}
    </div>
  );
}
