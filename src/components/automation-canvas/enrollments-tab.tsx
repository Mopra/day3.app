"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { FastForward, LogOut, UserPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Input } from "@/components/ui/input";
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
  ListFilter,
  ListNoResults,
  ListSkeleton,
  ListToolbar,
  RowActions,
} from "@/components/ui/data-list";
import { MenuItem } from "@/components/ui/menu";
import { EnrollmentStatusBadge } from "@/components/ui/status-badge";
import { useApi } from "@/lib/api";
import { nodeTitle } from "@/lib/automation-graph";
import type {
  AutomationDetail,
  EnrollOutcome,
  EnrollResult,
  EnrollmentPage,
  EnrollmentRow,
} from "@/lib/automation-types";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

const PAGE = 50;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STATUS_FILTERS = [
  { value: "all", label: "All statuses" },
  { value: "active", label: "Active" },
  { value: "sending", label: "Sending" },
  { value: "completed", label: "Completed" },
  { value: "exited", label: "Exited" },
  { value: "failed", label: "Failed" },
];

// The manual-enroll result, in the words a person needs to act on it.
const OUTCOME_COPY: Record<EnrollOutcome, { ok: boolean; text: string }> = {
  enrolled: { ok: true, text: "Enrolled. They start at the trigger right away." },
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

const EXIT_REASON_LABELS: Record<string, string> = {
  manual: "removed by you",
  automation_archived: "automation archived",
  loop_guard: "loop guard",
  exit_filter: "matched the exit condition",
  unsubscribed: "unsubscribed",
  suppressed: "suppressed",
  not_subscribed: "no longer subscribed",
};

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

  const [status, setStatus] = useState("all");
  const [page, setPage] = useState<EnrollmentPage | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [exiting, setExiting] = useState<EnrollmentRow | null>(null);

  const url = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({ limit: String(PAGE), offset: String(offset) });
      if (status !== "all") params.set("status", status);
      return `/api/automations/${detail.id}/enrollments?${params}`;
    },
    [detail.id, status],
  );

  // Only the newest request may set the page: flipping the status filter twice
  // quickly must not let the slower first response overwrite the second.
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
          toast.error(err instanceof Error ? err.message : "Couldn't load people");
        }
      });
  }, [api, url]);

  useEffect(() => {
    setPage(null);
    load();
  }, [load]);

  async function loadMore() {
    if (!page || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await api.get<EnrollmentPage>(url(page.rows.length));
      setPage({ ...next, rows: [...page.rows, ...next.rows] });
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
      toast.success(`${row.email} moves on now`);
      load();
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
      load();
      onCountsChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove them");
    } finally {
      setBusyId(null);
    }
  }

  // Manual enroll: the way to test a flow end to end with a real contact.
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

  const total = page?.total ?? 0;
  const shown = page?.rows.length ?? 0;

  return (
    <div className="space-y-4">
      <Card size="sm">
        <CardContent className="px-3">
          <form onSubmit={enroll} className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 items-center gap-2">
              <UserPlus className="size-4 shrink-0 text-muted-foreground" />
              <Input
                type="email"
                value={email}
                placeholder="Enroll a contact by email"
                aria-label="Email of the contact to enroll"
                onChange={(e) => {
                  setEmail(e.target.value);
                  setOutcome(null);
                }}
                disabled={enrolling}
              />
            </div>
            <Button
              type="submit"
              variant="outline"
              disabled={enrolling || !EMAIL_RE.test(email.trim().toLowerCase())}
            >
              {enrolling && <OrbitLoader size={14} />}
              Enroll
            </Button>
          </form>
          <p className={cn("mt-2 text-xs", outcome && !OUTCOME_COPY[outcome].ok ? "text-destructive" : "text-muted-foreground")}>
            {outcome
              ? OUTCOME_COPY[outcome].text
              : detail.status === "active"
                ? `Must already be a subscribed contact in ${detail.audienceName}. Handy for walking through the flow yourself.`
                : detail.status === "paused"
                  ? "Resume the automation to enroll someone."
                  : detail.status === "archived"
                    ? "An archived automation cannot enroll anyone."
                    : "Publish the automation to enroll someone."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardContent>
          <ListToolbar className="mb-4">
            <ListFilter
              value={status}
              onChange={setStatus}
              options={STATUS_FILTERS}
              ariaLabel="Filter by status"
            />
            {page && <ListCount shown={shown} total={total} noun="person" className="ml-auto" />}
          </ListToolbar>

          {page === null ? (
            <ListSkeleton />
          ) : page.rows.length === 0 ? (
            status === "all" ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                Nobody has entered this automation yet.
              </p>
            ) : (
              <ListNoResults
                onClear={() => setStatus("all")}
                message="Nobody matches this status."
              />
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
                        <TableRow key={r.id}>
                          <TableCell className="font-medium">{r.email}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5">
                              <EnrollmentStatusBadge status={r.status} />
                              {r.holdReason && (
                                <span className="text-xs text-muted-foreground">
                                  on hold: {r.holdReason.replace(/_/g, " ")}
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
                            {r.status === "active" ? formatDateTime(r.nextRunAt) : ""}
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
                                      <FastForward />
                                      Run now (skips the current wait)
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
              {shown < total && (
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
