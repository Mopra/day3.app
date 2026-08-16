"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Copy, Mail, Trash2 } from "lucide-react";
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
import { NextSteps } from "@/components/next-steps";
import { useApi } from "@/lib/api";
import { formatDate } from "@/lib/format";
import { CampaignStatusBadge } from "@/components/ui/campaign-status-badge";
import { SandboxBadge } from "@/components/sandbox-notice";
import { campaignStatusLabel } from "@/lib/format";
import type { CampaignListItem, OnboardingState } from "@/lib/types";

// A campaign mid-send can't be deleted (the worker is reading its rows); pause
// it first. Everything else — drafts, scheduled, paused, sent, failed — is fair
// game.
function canDelete(status: string): boolean {
  return status !== "sending" && status !== "generating_recipients";
}

export function CampaignsView({
  initialCampaigns,
  onboarding,
}: {
  initialCampaigns: CampaignListItem[];
  onboarding: OnboardingState;
}) {
  const api = useApi();
  const router = useRouter();
  // Seeded from the server render, then owned locally so a delete can drop a row
  // without a refetch. Re-synced whenever the server sends a new list (a
  // router.refresh() after a mutation, or a fresh navigation to this route).
  const [campaigns, setCampaigns] = useState<CampaignListItem[]>(initialCampaigns);
  useEffect(() => setCampaigns(initialCampaigns), [initialCampaigns]);
  const [status, setStatus] = useState("all");
  const [confirm, setConfirm] = useState<CampaignListItem | null>(null);
  const [deleting, setDeleting] = useState(false);

  async function duplicate(c: CampaignListItem) {
    try {
      const { id } = await api.post<{ id: string }>(`/api/campaigns/${c.id}/duplicate`);
      toast.success("Campaign duplicated");
      // Drop the user straight into the new draft to tweak subject/content and send.
      router.push(`/campaigns/${id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't duplicate campaign");
    }
  }

  async function remove() {
    if (!confirm) return;
    setDeleting(true);
    try {
      await api.del(`/api/campaigns/${confirm.id}`);
      toast.success("Campaign deleted");
      setCampaigns((cs) => cs.filter((c) => c.id !== confirm.id));
      setConfirm(null);
      // Re-run the server component so the list (and the onboarding strip, which
      // can flip on the last campaign going away) reflects the delete.
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete campaign");
    } finally {
      setDeleting(false);
    }
  }

  // Status options follow whatever's actually in the list, so we never show an
  // empty bucket.
  const statusOptions = useMemo(() => {
    const present = Array.from(new Set(campaigns.map((c) => c.status)));
    return [
      { value: "all", label: "All statuses" },
      ...present.map((s) => ({ value: s, label: campaignStatusLabel(s) })),
    ];
  }, [campaigns]);

  const list = useListController(campaigns, {
    searchText: (c) => `${c.name} ${c.subject}`,
    predicate: (c) => status === "all" || c.status === status,
    sortAccessors: {
      name: (c) => c.name,
      status: (c) => c.status,
      audience: (c) => c.audienceName,
      sent: (c) => c.sentCount,
      createdAt: (c) => c.createdAt,
    },
    initialSort: { key: "createdAt", dir: "desc" },
  });

  function clearFilters() {
    list.setSearch("");
    setStatus("all");
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="font-display text-2xl sm:text-3xl">Campaigns</h1>
        <Button render={<Link href="/campaigns/new">New campaign</Link>} />
      </div>

      <NextSteps onboarding={onboarding} hideWhenOn="campaign" />

      {campaigns.length > 0 && (
        <ListToolbar>
          <ListSearch
            value={list.search}
            onChange={list.setSearch}
            placeholder="Search name or subject…"
          />
          <ListFilter
            value={status}
            onChange={setStatus}
            options={statusOptions}
            ariaLabel="Filter by status"
          />
          <ListCount shown={list.shown} total={list.total} noun="campaign" className="ml-auto" />
        </ListToolbar>
      )}

      <Card>
        <CardContent>
          {list.isEmpty ? (
            <ListEmpty
              icon={Mail}
              title="Write the first update."
              description="Write your first product update and send it to your audience."
              action={<Button render={<Link href="/campaigns/new">New campaign</Link>} />}
            />
          ) : list.isFilteredEmpty ? (
            <ListNoResults onClear={clearFilters} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Name" sortKey="name" sort={list.sort} onSort={list.toggleSort} />
                  <TableHead>Subject</TableHead>
                  <SortableHead label="Status" sortKey="status" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Audience" sortKey="audience" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Sent" sortKey="sent" sort={list.sort} onSort={list.toggleSort} align="right" />
                  <SortableHead label="Created" sortKey="createdAt" sort={list.sort} onSort={list.toggleSort} />
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.view.map((c) => (
                  <TableRow key={c.id} {...rowLinkProps(() => router.push(`/campaigns/${c.id}`))}>
                    <TableCell>
                      <Link
                        href={`/campaigns/${c.id}`}
                        className="font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground">
                      {c.subject}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <CampaignStatusBadge status={c.status} scheduledAt={c.scheduledAt} />
                        {c.sandbox && <SandboxBadge />}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.audienceName ?? "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.sentCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(c.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <RowOpen href={`/campaigns/${c.id}`} />
                        <RowActions>
                          <MenuItem onClick={() => duplicate(c)}>
                            <Copy />
                            Duplicate
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem
                            variant="destructive"
                            disabled={!canDelete(c.status)}
                            onClick={() => setConfirm(c)}
                          >
                            <Trash2 />
                            Delete
                          </MenuItem>
                        </RowActions>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={`Delete "${confirm?.name}"?`}
        description="This permanently removes the campaign and its recipient records. Sent campaigns are removed from your history too. This can't be undone."
        confirmLabel="Delete campaign"
        busy={deleting}
        onConfirm={remove}
      />
    </div>
  );
}
