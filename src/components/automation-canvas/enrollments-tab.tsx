"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { FastForward, LogOut, RotateCcw, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
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
  ListChips,
  ListCount,
  ListEmpty,
  ListNoResults,
  ListSearch,
  ListSkeleton,
  ListToolbar,
  RowActions,
  rowLinkProps,
} from "@/components/ui/data-list";
import { MenuItem } from "@/components/ui/menu";
import { EnrollmentStatusBadge } from "@/components/ui/status-badge";
import { useApi } from "@/lib/api";
import { nodeTitle } from "@/lib/automation-graph";
import type {
  AutomationDetail,
  EnrollOutcome,
  EnrollResult,
  EnrollmentDetail,
  EnrollmentPage,
  EnrollmentRow,
  EnrollmentSendRow,
} from "@/lib/automation-types";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const PAGE = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// A flow moves on its own: waits expire, holds retry, the worker sends. Without
// a poll the page goes stale exactly while someone is watching it, which is
// when they are walking a test contact through the steps.
const POLL_MS = 15_000;

// The manual-enroll result, in the words a person needs to act on it.
const OUTCOME_COPY: Record<EnrollOutcome, { ok: boolean; text: string }> = {
  enrolled: { ok: true, text: "Enrolled. They start at the trigger right away (or when you resume, if paused)." },
  already_enrolled: {
    ok: false,
    text: "They are already in this automation, or have been and re-entry is off.",
  },
  automation_not_active: { ok: false, text: "Publish the automation first; a draft cannot enroll anyone." },
  not_subscribed: { ok: false, text: "That contact is not subscribed in this audience." },
  suppressed: { ok: false, text: "That address is suppressed, so it cannot be mailed." },
  entry_filter_no_match: { ok: false, text: "That contact does not match the entry filter." },
  sandbox_not_member: {
    ok: false,
    text: "On the free plan automations only reach members of your organization.",
  },
  wrong_audience: { ok: false, text: "That contact is not in this automation's audience." },
};

// Why an active enrollment is parked, in words, with where to fix it. Every
// hold_reason the engine and the send handler write is here; an unknown one
// falls back to the code with underscores removed rather than to nothing.
const HOLD_REASON_COPY: Record<string, { text: string; href?: string; cta?: string }> = {
  quota: { text: "monthly email allowance used up", href: "/billing", cta: "Billing" },
  subscription_inactive: { text: "subscription is past due", href: "/billing", cta: "Billing" },
  risk_paused: { text: "account paused for reputation", href: "/settings", cta: "Settings" },
  sending_disabled: { text: "plan cannot send yet", href: "/billing", cta: "Billing" },
  account_missing: { text: "account not found" },
  automation_paused: { text: "waiting for you to resume" },
  from_identity_missing: { text: "no From address on this automation", cta: "Settings tab" },
  domain_not_verified: { text: "sending domain is not verified", href: "/domains", cta: "Domains" },
  domain_missing: { text: "sending domain was removed", cta: "Settings tab" },
  sender_not_verified: { text: "the provider rejected the From address", href: "/domains", cta: "Domains" },
  provider_daily_limit: { text: "daily sending limit reached, retrying hourly" },
  provider_suspended: { text: "sending is suspended at the provider" },
  provider_misconfigured: { text: "sending is misconfigured, we are on it" },
};

function HoldNote({ reason }: { reason: string }) {
  const copy = HOLD_REASON_COPY[reason];
  return (
    <span className="text-xs text-muted-foreground">
      Held: {copy?.text ?? reason.replace(/_/g, " ")}
      {copy?.href && (
        <>
          {" "}
          <Link href={copy.href} className="underline underline-offset-2 hover:text-foreground">
            {copy.cta}
          </Link>
        </>
      )}
    </span>
  );
}

const EXIT_REASON_LABELS: Record<string, string> = {
  manual: "removed by you",
  automation_archived: "automation archived",
  loop_guard: "loop guard",
  exit_filter: "matched the exit condition",
  unsubscribed: "unsubscribed",
  suppressed: "suppressed",
  not_subscribed: "no longer subscribed",
};

// One ledger row's state, said plainly. The ledger is shared with campaigns, so
// these are the campaign statuses; only a skipped row needs the automation's own
// vocabulary, which is why its reason is spelled out separately below.
const SEND_STATUS_LABELS: Record<string, string> = {
  pending: "Queued",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  bounced: "Bounced",
  complained: "Marked as spam",
  unsubscribed: "Unsubscribed",
  failed: "Failed",
  skipped: "Not sent",
};

// Every reason the engine writes onto a skipped ledger row, in words that say
// whether it was the sender's doing, the recipient's, or ours.
const SKIP_REASON_COPY: Record<string, string> = {
  too_stale: "Held for over 7 days, so the flow moved on without sending.",
  invalid_config: "This step has no subject or body yet.",
  unsubscribed: "They unsubscribed before this step came around.",
  not_subscribed: "They were no longer a subscribed contact.",
  suppressed: "The address was suppressed by then.",
  sandbox_not_member: "Sandbox: they are not a member of your organization.",
  topic_opted_out: "They opted out of this automation's topic.",
};

/* ────────────────────────── one person's drawer ────────────────────────── */

// The emails one person has had out of this flow, oldest first. Titles come from
// the graph the tab already holds: the ledger row carries the node key, so a
// renamed step shows its current name instead of a copy frozen at send time.
function SendTimeline({
  sends,
  titles,
}: {
  sends: EnrollmentSendRow[];
  titles: Map<string, string>;
}) {
  if (sends.length === 0) {
    return (
      <p className="rounded-lg border border-border p-3 text-sm text-muted-foreground">
        No email has gone out to them from this automation yet.
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {sends.map((s) => {
        const when = s.sentAt ?? s.createdAt;
        const engagement = [
          s.openedAt ? `Opened ${formatDateTime(s.openedAt)}` : null,
          s.clickedAt ? `Clicked ${formatDateTime(s.clickedAt)}` : null,
        ].filter(Boolean);
        const skip = s.status === "skipped" ? (SKIP_REASON_COPY[s.error ?? ""] ?? s.error) : null;
        return (
          <div key={s.id} className="rounded-lg border border-border p-3">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-sm font-medium">
                {s.nodeKey ? (titles.get(s.nodeKey) ?? "A removed step") : "A step"}
                {s.visitNo > 0 && (
                  <span className="ml-1.5 text-xs text-muted-foreground">lap {s.visitNo + 1}</span>
                )}
              </span>
              <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                {formatDateTime(when)}
              </span>
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {SEND_STATUS_LABELS[s.status] ?? s.status}
              {engagement.length > 0 && ` · ${engagement.join(" · ")}`}
            </p>
            {skip && <p className="mt-1 text-xs text-muted-foreground">{skip}</p>}
            {s.status === "failed" && s.error && (
              <p className="mt-1 text-xs break-all text-destructive">{s.error}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-sm break-all">{children}</span>
    </div>
  );
}

/* ──────────────────────────────── the tab ─────────────────────────────── */

export function EnrollmentsTab({
  detail,
  onCountsChanged,
}: {
  detail: AutomationDetail;
  // Enroll / exit change the counts in the header; the parent refetches.
  onCountsChanged: () => void;
}) {
  const api = useApi();
  // Step names come from the version people are actually on; the live graph
  // when published, the draft before that.
  const graph = detail.live ?? detail.draft;
  const titles = new Map(graph.nodes.map((n) => [n.key, nodeTitle(n)]));

  const [filter, setFilter] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState<EnrollmentPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [exiting, setExiting] = useState<EnrollmentRow | null>(null);
  const [opened, setOpened] = useState<EnrollmentRow | null>(null);

  // Not a query per keystroke: the search runs in Postgres across the whole
  // flow, so it waits for the typist to pause.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const url = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (filter) params.set("status", filter);
      if (search) params.set("q", search);
      return `/api/automations/${detail.id}/enrollments?${params}`;
    },
    [detail.id, filter, search],
  );

  // Only the newest request may set the page: flipping the filter twice quickly
  // must not let the slower first response overwrite the second.
  const loadSeq = useRef(0);
  const load = useCallback(() => {
    const seq = ++loadSeq.current;
    api
      .get<EnrollmentPage>(url(0))
      .then((next) => {
        if (seq === loadSeq.current) setPage(next);
      })
      .catch((err) => {
        if (seq === loadSeq.current) {
          toast.error(err instanceof Error ? err.message : "Couldn't load enrollments");
        }
      });
  }, [api, url]);

  useEffect(() => {
    setPage(null);
    load();
  }, [load]);

  // Reload as many rows as are on screen so an action on page 3 does not throw
  // the reader back to page 1.
  const reload = useCallback(() => {
    const seq = ++loadSeq.current;
    const limit = Math.min(Math.max(page?.rows.length ?? PAGE, PAGE), 200);
    const params = new URL(url(0), window.location.origin);
    params.searchParams.set("limit", String(limit));
    api
      .get<EnrollmentPage>(params.pathname + params.search)
      .then((next) => {
        if (seq !== loadSeq.current) return;
        setPage(next);
        // An open drawer is reading one of these rows: hand it the fresh one so
        // a status that changed under it (held, sending, finished) shows there
        // too, and keep the old one if the refresh no longer lists it.
        setOpened((current) =>
          current ? (next.rows.find((r) => r.id === current.id) ?? current) : current,
        );
      })
      .catch(() => {
        /* the next poll or action reloads */
      });
  }, [api, url, page?.rows.length]);

  async function loadMore() {
    if (!page || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.get<EnrollmentPage>(url(page.rows.length));
      // Newest-first offset paging shifts when someone enrolls between pages;
      // drop any row already on screen so keys stay unique.
      const seen = new Set(page.rows.map((r) => r.id));
      setPage({ ...next, rows: [...page.rows, ...next.rows.filter((r) => !seen.has(r.id))] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load more");
    } finally {
      setLoadingMore(false);
    }
  }

  async function runNow(row: EnrollmentRow) {
    setBusyId(row.id);
    try {
      await api.post(`/api/automations/${detail.id}/enrollments/${row.id}/run-now`);
      toast.success(
        row.holdReason
          ? `Retrying ${row.email} now. If the hold is still in place they stay held.`
          : `${row.email} moves on now`,
      );
      reload();
      refreshPerson();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't run the step");
    } finally {
      setBusyId(null);
    }
  }

  async function exit() {
    if (!exiting) return;
    setBusyId(exiting.id);
    try {
      await api.post(`/api/automations/${detail.id}/enrollments/${exiting.id}/exit`);
      toast.success(`${exiting.email} removed from the automation`);
      setExiting(null);
      setOpened(null);
      reload();
      onCountsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove them");
    } finally {
      setBusyId(null);
    }
  }

  /* ─── one person's run, fetched when their row is opened ─── */

  const [person, setPerson] = useState<EnrollmentDetail | null>(null);
  const openedId = opened?.id ?? null;
  // Keyed on the id, not the row: the poll above swaps the row object every 15
  // seconds, and refetching on that would blank the drawer under the reader.
  useEffect(() => {
    if (!openedId) {
      setPerson(null);
      return;
    }
    let cancelled = false;
    setPerson(null);
    api
      .get<EnrollmentDetail>(`/api/automations/${detail.id}/enrollments/${openedId}`)
      .then((d) => {
        if (!cancelled) setPerson(d);
      })
      .catch((err) => {
        if (!cancelled) {
          toast.error(err instanceof Error ? err.message : "Couldn't load this person");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api, detail.id, openedId]);

  // The same refresh the list gets, for the open drawer: an email that goes out
  // while someone watches their own test run should appear without a click.
  const refreshPerson = useCallback(() => {
    if (!openedId) return;
    api
      .get<EnrollmentDetail>(`/api/automations/${detail.id}/enrollments/${openedId}`)
      .then(setPerson)
      .catch(() => {
        /* the next poll retries */
      });
  }, [api, detail.id, openedId]);
  const reloadRef = useRef(reload);
  useEffect(() => {
    reloadRef.current = reload;
  }, [reload]);
  const refreshPersonRef = useRef(refreshPerson);
  useEffect(() => {
    refreshPersonRef.current = refreshPerson;
  }, [refreshPerson]);

  // A flow moves on its own, so the page refreshes itself: the list, and the
  // open drawer with it. Both are read through refs so that loading a further
  // page (which rebuilds `reload`) doesn't restart the timer. A hidden tab is
  // skipped: a flow left open on a second monitor should not query all
  // afternoon.
  const live = detail.status === "active" || detail.status === "paused";
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      reloadRef.current();
      refreshPersonRef.current();
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [live]);

  /* ─── manual enroll: the way to walk a real contact through the flow ─── */

  const [email, setEmail] = useState("");
  const [enrolling, setEnrolling] = useState(false);
  const [outcome, setOutcome] = useState<EnrollOutcome | null>(null);

  async function enroll(e: React.FormEvent) {
    e.preventDefault();
    const value = email.trim().toLowerCase();
    if (!EMAIL_RE.test(value) || enrolling) return;
    setEnrolling(true);
    setOutcome(null);
    try {
      const res = await api.post<EnrollResult>(`/api/automations/${detail.id}/enrollments`, {
        email: value,
      });
      setOutcome(res.outcome);
      if (res.outcome === "enrolled") {
        setEmail("");
        load();
        onCountsChanged();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't enroll that contact");
    } finally {
      setEnrolling(false);
    }
  }

  // The chips are the flow's shape, so they count everyone, not the filtered
  // page. `in_progress` and `held` split what the engine calls `active`: moving
  // versus parked, which is the only distinction anyone acts on.
  const counts = page?.counts ?? detail.counts;
  const chips = [
    { value: "", label: "Everyone", count: counts.total },
    {
      value: "in_progress",
      label: "In progress",
      count: Math.max(0, counts.active - counts.held) + counts.sending,
    },
    { value: "held", label: "Held", count: counts.held, tone: "alert" as const },
    { value: "completed", label: "Finished", count: counts.completed },
    { value: "exited", label: "Left", count: counts.exited },
    { value: "failed", label: "Failed", count: counts.failed, tone: "alert" as const },
  ];

  const total = page?.total ?? 0;
  const shown = page?.rows.length ?? 0;
  const narrowed = !!filter || !!search;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Everyone who has entered this automation, where they are in it, and when their next step
        runs. Open a row to see every email one person has had out of this flow.
      </p>

      <Card>
        <CardContent>
          <ListToolbar className="mb-4">
            <ListSearch
              value={searchInput}
              onChange={setSearchInput}
              placeholder="Search by email…"
            />
            <ListChips
              value={filter}
              onChange={setFilter}
              options={chips}
              ariaLabel="Filter by where people are"
            />
            <EnrollPopover
              detail={detail}
              email={email}
              setEmail={setEmail}
              enrolling={enrolling}
              outcome={outcome}
              setOutcome={setOutcome}
              onSubmit={enroll}
            />
          </ListToolbar>

          {page === null ? (
            <ListSkeleton />
          ) : page.rows.length === 0 ? (
            narrowed ? (
              <ListNoResults
                onClear={() => {
                  setFilter("");
                  setSearchInput("");
                }}
                message={
                  search
                    ? `Nobody matching "${search}" has entered this automation.`
                    : "Nobody is in this part of the flow."
                }
              />
            ) : (
              <ListEmpty icon={Users} title="Nobody here yet" description={emptyCopy(detail)} />
            )
          ) : (
            <>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Email</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Current step</TableHead>
                      <TableHead>Next run</TableHead>
                      <TableHead>Entered</TableHead>
                      <TableHead />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {page.rows.map((r) => {
                      const canRun = r.status === "active";
                      const canExit = r.status === "active" || r.status === "sending";
                      return (
                        <TableRow key={r.id} {...rowLinkProps(() => setOpened(r))}>
                          <TableCell className="font-medium">{r.email}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <EnrollmentStatusBadge status={r.status} />
                              {r.status === "active" && r.holdReason && <HoldNote reason={r.holdReason} />}
                              {r.status === "failed" && r.lastError && (
                                <span className="text-xs text-muted-foreground" title={r.lastError}>
                                  {r.lastError}
                                </span>
                              )}
                            </div>
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {r.status === "exited" && r.exitReason
                              ? `Left: ${EXIT_REASON_LABELS[r.exitReason] ?? r.exitReason.replace(/_/g, " ")}`
                              : r.status === "completed"
                                ? "Finished"
                                : r.currentNodeKey
                                  ? (titles.get(r.currentNodeKey) ?? "A removed step")
                                  : ""}
                            {r.versionNumber !== detail.liveVersion?.version && (
                              <span className="ml-1.5 text-xs">v{r.versionNumber}</span>
                            )}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {r.status === "active"
                              ? r.holdReason
                                ? `retry ${formatDateTime(r.nextRunAt)}`
                                : formatDateTime(r.nextRunAt)
                              : ""}
                          </TableCell>
                          <TableCell className="text-muted-foreground">
                            {formatDateTime(r.enteredAt)}
                          </TableCell>
                          <TableCell className="text-right">
                            {(canRun || canExit) && (
                              <div className="flex items-center justify-end">
                                <RowActions label="Actions">
                                  {canRun && (
                                    <MenuItem disabled={busyId === r.id} onClick={() => runNow(r)}>
                                      {r.holdReason ? <RotateCcw /> : <FastForward />}
                                      {r.holdReason ? "Retry now" : "Run now (skips the current wait)"}
                                    </MenuItem>
                                  )}
                                  {canExit && (
                                    <MenuItem
                                      variant="destructive"
                                      disabled={busyId === r.id}
                                      onClick={() => setExiting(r)}
                                    >
                                      <LogOut />
                                      Remove from automation
                                    </MenuItem>
                                  )}
                                </RowActions>
                              </div>
                            )}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
              <div className="flex items-center justify-between gap-3 pt-4">
                <ListCount shown={shown} total={total} noun="person" many="people" />
                {shown < total && (
                  <Button variant="outline" size="sm" onClick={loadMore} disabled={loadingMore}>
                    {loadingMore && <OrbitLoader size={16} />}
                    Load more
                    <span className="text-muted-foreground tabular-nums">
                      ({(total - shown).toLocaleString()} more)
                    </span>
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      {/* One person's run: where they are, and what actually landed in their
          inbox. The question this tab gets opened for. */}
      <Sheet open={!!opened} onOpenChange={(o) => !o && setOpened(null)}>
        <SheetContent side="right" className="overflow-y-auto p-4 sm:max-w-lg sm:p-6">
          {opened && (
            <div className="space-y-5">
              <SheetHeader className="p-0 pr-8">
                <SheetTitle className="break-all">{opened.email}</SheetTitle>
                <SheetDescription>{personSummary(opened, titles)}</SheetDescription>
              </SheetHeader>

              <div className="grid grid-cols-2 gap-3">
                <DetailRow label="Status">
                  <EnrollmentStatusBadge status={opened.status} />
                </DetailRow>
                <DetailRow label="Entered">{formatDateTime(opened.enteredAt)}</DetailRow>
                {opened.status === "active" && (
                  <DetailRow label={opened.holdReason ? "Retries" : "Next step runs"}>
                    {formatDateTime(opened.nextRunAt)}
                  </DetailRow>
                )}
                {opened.completedAt && (
                  <DetailRow label="Finished">{formatDateTime(opened.completedAt)}</DetailRow>
                )}
                {opened.exitedAt && (
                  <DetailRow label="Left">
                    {formatDateTime(opened.exitedAt)}
                    {opened.exitReason &&
                      ` · ${EXIT_REASON_LABELS[opened.exitReason] ?? opened.exitReason.replace(/_/g, " ")}`}
                  </DetailRow>
                )}
                <DetailRow label="Version">v{opened.versionNumber}</DetailRow>
              </div>

              {opened.holdReason && (
                <p className="rounded-lg border border-caramel/40 p-3">
                  <HoldNote reason={opened.holdReason} />
                </p>
              )}
              {opened.lastError && (
                <p className="rounded-lg border border-destructive/40 p-3 text-sm break-all text-destructive">
                  {opened.lastError}
                </p>
              )}

              <div className="space-y-2">
                <span className="text-xs text-muted-foreground">Emails from this automation</span>
                {person === null ? (
                  <ListSkeleton rows={2} />
                ) : (
                  <SendTimeline sends={person.sends} titles={titles} />
                )}
              </div>

              {(opened.status === "active" || opened.status === "sending") && (
                <div className="flex flex-wrap gap-2">
                  {opened.status === "active" && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busyId === opened.id}
                      onClick={() => runNow(opened)}
                    >
                      {opened.holdReason ? <RotateCcw /> : <FastForward />}
                      {opened.holdReason ? "Retry now" : "Run the next step now"}
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busyId === opened.id}
                    onClick={() => setExiting(opened)}
                  >
                    <LogOut />
                    Remove from automation
                  </Button>
                </div>
              )}
            </div>
          )}
        </SheetContent>
      </Sheet>

      <ConfirmDialog
        open={!!exiting}
        onOpenChange={(o) => !o && setExiting(null)}
        title={`Remove ${exiting?.email ?? "this contact"}?`}
        description="They leave the automation now and receive nothing further from it. Whether they can enter again depends on the re-entry setting."
        confirmLabel="Remove"
        busy={busyId === exiting?.id}
        onConfirm={exit}
      />
    </div>
  );
}

/* ─────────────────────────── enroll by hand ──────────────────────────── */

// Tucked into the toolbar rather than spread across the top of the page: it is a
// testing tool, used once per flow, next to a list that is read every day.
function EnrollPopover({
  detail,
  email,
  setEmail,
  enrolling,
  outcome,
  setOutcome,
  onSubmit,
}: {
  detail: AutomationDetail;
  email: string;
  setEmail: (v: string) => void;
  enrolling: boolean;
  outcome: EnrollOutcome | null;
  setOutcome: (v: EnrollOutcome | null) => void;
  onSubmit: (e: React.FormEvent) => void;
}) {
  const closed = detail.status === "draft" || detail.status === "archived";
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            className="sm:ml-auto"
            disabled={closed}
            title={
              closed
                ? detail.status === "draft"
                  ? "Publish the automation to enroll someone"
                  : "An archived automation cannot enroll anyone"
                : undefined
            }
          >
            <UserPlus />
            Enroll a contact
          </Button>
        }
      />
      <PopoverContent side="bottom" align="end" className="w-80 p-3">
        <form onSubmit={onSubmit} className="flex items-center gap-2">
          <Input
            type="email"
            value={email}
            placeholder="name@example.com"
            aria-label="Email of the contact to enroll"
            onChange={(e) => {
              setEmail(e.target.value);
              setOutcome(null);
            }}
            disabled={enrolling}
          />
          <Button
            type="submit"
            variant="outline"
            disabled={enrolling || !EMAIL_RE.test(email.trim().toLowerCase())}
          >
            {enrolling && <OrbitLoader size={14} />}
            Enroll
          </Button>
        </form>
        <p
          className={cn(
            "mt-2 text-xs",
            outcome && !(OUTCOME_COPY[outcome]?.ok ?? false)
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {outcome
            ? (OUTCOME_COPY[outcome]?.text ?? outcome.replace(/_/g, " "))
            : detail.status === "paused"
              ? "They wait at the start until you resume."
              : `They start at the trigger, exactly as an automatic entry would. Must already be a subscribed contact in ${detail.audienceName}.${detail.sandbox ? " Sandbox: only members of your organization can be enrolled." : ""}`}
        </p>
      </PopoverContent>
    </Popover>
  );
}

/* ────────────────────────────── copy helpers ─────────────────────────── */

// An empty list is a question ("why is nobody here?"), so the answer depends on
// what the automation is doing, not on the list being empty.
function emptyCopy(detail: AutomationDetail): string {
  if (detail.status === "draft") {
    return "Publish this automation and everyone who enters it shows up here, with the step they are on.";
  }
  if (detail.status === "archived") {
    return "This automation is archived. Nobody can enter it, and everyone who was in it has left.";
  }
  if (detail.triggerKind === "api") {
    return "Nobody has been enrolled yet. Your app enrolls people through the API, or you can add someone by hand.";
  }
  return `Nobody has joined since you published. Anyone who subscribes to ${detail.audienceName} enters here${
    detail.entryFilter ? " if they match the entry filter" : ""
  }.`;
}

// The one-line story at the top of the drawer: where this person is, in words.
function personSummary(row: EnrollmentRow, titles: Map<string, string>): string {
  const step = row.currentNodeKey
    ? (titles.get(row.currentNodeKey) ?? "a step that has been removed")
    : null;
  if (row.status === "completed") return "They reached the end of the flow.";
  if (row.status === "exited") {
    const why = row.exitReason
      ? (EXIT_REASON_LABELS[row.exitReason] ?? row.exitReason.replace(/_/g, " "))
      : null;
    return why ? `They left the flow: ${why}.` : "They left the flow.";
  }
  if (row.status === "failed") return "Their run stopped on an error and is not continuing.";
  if (row.status === "sending") return `An email from ${step ?? "a step"} is going out right now.`;
  if (row.holdReason) return `Parked at ${step ?? "a step"}, waiting for something to clear.`;
  return `Waiting at ${step ?? "a step"}.`;
}
