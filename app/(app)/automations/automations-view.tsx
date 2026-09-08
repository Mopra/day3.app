"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Archive, Pause, Play, Trash2, Workflow } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
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
  RowActions,
  RowOpen,
  SortableHead,
  rowLinkProps,
  useListController,
} from "@/components/ui/data-list";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { NewAutomationDialog } from "@/components/new-automation-dialog";
import { SandboxBadge } from "@/components/sandbox-notice";
import { AutomationStatusBadge } from "@/components/ui/status-badge";
import { useApi } from "@/lib/api";
import { automationStatusLabel, formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AutomationDetail, AutomationListRow } from "@/lib/automation-types";
import type { Audience } from "@/lib/types";

// The badges used to be defined here; other pages import them from this module,
// so they stay reachable while living with the rest of the status badges in ui/.
export { AutomationStatusBadge, EnrollmentStatusBadge } from "@/components/ui/status-badge";

// What starts the automation, as a sentence. The audience trigger names the
// audience because that is the one thing a reader scanning the list wants to
// confirm ("is this the one for the beta list?").
export function triggerSentence(
  row: Pick<AutomationListRow, "triggerKind" | "audienceName">,
): string {
  return row.triggerKind === "api"
    ? "When your app enrolls them"
    : `When someone joins ${row.audienceName}`;
}

// A published automation is archived (the row stays, in-flight people are let
// out); a draft nobody ever published is simply deleted, because there is nothing
// to keep. The verb follows what actually happens so "Delete" never quietly
// archives and "Archive" never quietly deletes.
function removalVerb(a: AutomationListRow): "archive" | "delete" {
  return a.liveVersion === null && a.status === "draft" ? "delete" : "archive";
}

export function AutomationsView({
  initialAutomations,
  initialAudiences,
}: {
  initialAutomations: AutomationListRow[];
  initialAudiences: Audience[];
}) {
  const api = useApi();
  const router = useRouter();
  // Seeded from the server render, then owned locally so pause/resume/archive can
  // update a row without a refetch. Re-synced whenever the server sends a new list
  // (a router.refresh() after a mutation, or a fresh navigation to this route).
  const [automations, setAutomations] = useState<AutomationListRow[]>(initialAutomations);
  const [audiences, setAudiences] = useState<Audience[]>(initialAudiences);
  useEffect(() => {
    setAutomations(initialAutomations);
    setAudiences(initialAudiences);
  }, [initialAutomations, initialAudiences]);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [status, setStatus] = useState("all");
  const [confirm, setConfirm] = useState<AutomationListRow | null>(null);
  const [removing, setRemoving] = useState(false);

  // Pause/resume answer with the full detail; fold the parts the list shows back
  // into the row so the badge flips before the server re-render lands.
  function applyDetail(detail: AutomationDetail) {
    setAutomations((rows) =>
      rows.map((r) =>
        r.id === detail.id
          ? {
              ...r,
              status: detail.status,
              liveVersion: detail.liveVersion?.version ?? null,
              sandbox: detail.sandbox,
              counts: detail.counts,
              updatedAt: detail.updatedAt,
            }
          : r,
      ),
    );
  }

  async function pause(a: AutomationListRow) {
    try {
      const detail = await api.post<AutomationDetail>(`/api/automations/${a.id}/pause`);
      applyDetail(detail);
      toast.success("Automation paused");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't pause the automation");
    }
  }

  async function resume(a: AutomationListRow) {
    try {
      const detail = await api.post<AutomationDetail>(`/api/automations/${a.id}/resume`);
      applyDetail(detail);
      toast.success("Automation running again");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't resume the automation");
    }
  }

  async function remove() {
    if (!confirm) return;
    const verb = removalVerb(confirm);
    setRemoving(true);
    try {
      await api.del(`/api/automations/${confirm.id}`);
      if (verb === "delete") {
        toast.success("Automation deleted");
        setAutomations((rows) => rows.filter((r) => r.id !== confirm.id));
      } else {
        toast.success("Automation archived");
        setAutomations((rows) =>
          rows.map((r) => (r.id === confirm.id ? { ...r, status: "archived" } : r)),
        );
      }
      setConfirm(null);
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : verb === "delete"
            ? "Couldn't delete the automation"
            : "Couldn't archive the automation",
      );
    } finally {
      setRemoving(false);
    }
  }

  // Status options follow whatever's actually in the list, so we never show an
  // empty bucket.
  const statusOptions = useMemo(() => {
    const present = Array.from(new Set(automations.map((a) => a.status)));
    return [
      { value: "all", label: "All statuses" },
      ...present.map((s) => ({ value: s, label: automationStatusLabel(s) })),
    ];
  }, [automations]);

  const list = useListController(automations, {
    searchText: (a) => `${a.name} ${a.audienceName}`,
    predicate: (a) => status === "all" || a.status === status,
    sortAccessors: {
      name: (a) => a.name,
      status: (a) => a.status,
      trigger: (a) => triggerSentence(a),
      version: (a) => a.liveVersion ?? -1,
      people: (a) => a.counts.active,
      updatedAt: (a) => a.updatedAt,
    },
    initialSort: { key: "updatedAt", dir: "desc" },
  });

  function clearFilters() {
    list.setSearch("");
    setStatus("all");
  }

  const confirmVerb = confirm ? removalVerb(confirm) : "archive";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl sm:text-3xl">Automations</h1>
        <Button onClick={() => setDialogOpen(true)} disabled={audiences.length === 0}>
          New automation
        </Button>
      </div>

      {automations.length > 0 && (
        <ListToolbar>
          <ListSearch
            value={list.search}
            onChange={list.setSearch}
            placeholder="Search automations…"
          />
          <ListFilter
            value={status}
            onChange={setStatus}
            options={statusOptions}
            ariaLabel="Filter by status"
          />
          <ListCount
            shown={list.shown}
            total={list.total}
            noun="automation"
            className="ml-auto"
          />
        </ListToolbar>
      )}

      <Card>
        <CardContent>
          {list.isEmpty ? (
            <ListEmpty
              icon={Workflow}
              title="Send a welcome email the moment someone joins."
              description={
                audiences.length === 0
                  ? "First create an audience, so the automation has someone to greet. Unlimited automations and runs; you only pay for the emails."
                  : "Unlimited automations and runs; you only pay for the emails. Start from a template and publish when it reads right."
              }
              action={
                audiences.length === 0 ? (
                  <Button render={<Link href="/audiences">Create an audience</Link>} />
                ) : (
                  <Button onClick={() => setDialogOpen(true)}>New automation</Button>
                )
              }
            />
          ) : list.isFilteredEmpty ? (
            <ListNoResults onClear={clearFilters} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Name" sortKey="name" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Status" sortKey="status" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Trigger" sortKey="trigger" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Live version" sortKey="version" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="People" sortKey="people" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Updated" sortKey="updatedAt" sort={list.sort} onSort={list.toggleSort} />
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.view.map((a) => {
                  const verb = removalVerb(a);
                  return (
                    <TableRow
                      key={a.id}
                      {...rowLinkProps(() => router.push(`/automations/${a.id}`))}
                    >
                      <TableCell>
                        <Link
                          href={`/automations/${a.id}`}
                          className="font-medium hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {a.name}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          <AutomationStatusBadge status={a.status} />
                          {a.sandbox && <SandboxBadge />}
                        </div>
                      </TableCell>
                      <TableCell className="max-w-64 truncate text-muted-foreground">
                        {triggerSentence(a)}
                      </TableCell>
                      <TableCell
                        className={cn(
                          "tabular-nums",
                          a.liveVersion === null && "text-muted-foreground",
                        )}
                      >
                        {a.liveVersion === null ? "Not published" : `v${a.liveVersion}`}
                      </TableCell>
                      <TableCell>
                        <PeopleCell counts={a.counts} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {formatDate(a.updatedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex items-center justify-end gap-1">
                          <RowOpen href={`/automations/${a.id}`} />
                          <RowActions>
                            {a.status === "active" && (
                              <MenuItem onClick={() => pause(a)}>
                                <Pause />
                                Pause
                              </MenuItem>
                            )}
                            {a.status === "paused" && (
                              <MenuItem onClick={() => resume(a)}>
                                <Play />
                                Resume
                              </MenuItem>
                            )}
                            {(a.status === "active" || a.status === "paused") && (
                              <MenuSeparator />
                            )}
                            <MenuItem
                              variant="destructive"
                              disabled={a.status === "archived"}
                              onClick={() => setConfirm(a)}
                            >
                              {verb === "delete" ? <Trash2 /> : <Archive />}
                              {verb === "delete" ? "Delete" : "Archive"}
                            </MenuItem>
                          </RowActions>
                        </div>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <NewAutomationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        audiences={audiences}
      />

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={
          confirmVerb === "delete"
            ? `Delete "${confirm?.name}"?`
            : `Archive "${confirm?.name}"?`
        }
        description={
          confirmVerb === "delete"
            ? "This draft was never published, so nobody is in it. Deleting removes it for good."
            : "Nobody new can enter, and everyone in it right now stops where they are and gets no more of its emails. The automation stays in your list as archived, with its history."
        }
        confirmLabel={confirmVerb === "delete" ? "Delete automation" : "Archive automation"}
        busy={removing}
        onConfirm={remove}
      />
    </div>
  );
}

// "12 in progress" over "340 completed": the live number leads because it is the
// one that changes; the finished count sits under it in grey.
function PeopleCell({ counts }: { counts: AutomationListRow["counts"] }) {
  if (counts.total === 0) {
    return <span className="text-muted-foreground">No one yet</span>;
  }
  return (
    <div className="flex flex-col leading-tight">
      <span className="tabular-nums">
        {counts.active.toLocaleString()}{" "}
        <span className="text-muted-foreground">in progress</span>
      </span>
      <span className="text-xs text-muted-foreground tabular-nums">
        {counts.completed.toLocaleString()} completed
      </span>
    </div>
  );
}
