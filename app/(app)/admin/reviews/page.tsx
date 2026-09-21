"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  ListClear,
  ListCount,
  ListEmpty,
  ListFilter,
  ListNoResults,
  ListSearch,
  ListSkeleton,
  ListToolbar,
  buildFilterOptions,
  useListController,
} from "@/components/ui/data-list";
import { EmailPreview } from "@/components/email-preview";
import { useApi } from "@/lib/api";
import { statusLabel, statusVariant } from "@/lib/format";
import type { AdminReviewRow } from "@/lib/types";

export default function AdminReviewsPage() {
  const api = useApi();
  const [reviews, setReviews] = useState<AdminReviewRow[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    api
      .get<{ reviews: AdminReviewRow[] }>("/api/admin/reviews")
      .then((res) => setReviews(res.reviews))
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load]);

  // Highest-risk campaigns surface first — that's what a reviewer wants to see.
  const list = useListController(reviews, {
    searchText: (r) => `${r.campaign.name} ${r.accountName} ${r.campaign.subject}`,
    filters: { risk: "all" },
    predicate: (r, f) => f.risk === "all" || (r.campaign.riskLevel ?? "unscored") === f.risk,
    sortAccessors: { risk: (r) => r.campaign.riskScore ?? -1 },
    initialSort: { key: "risk", dir: "desc" },
    persist: { key: "admin.reviews" },
  });

  const riskOptions = useMemo(
    () =>
      buildFilterOptions({
        all: "All risk levels",
        values: (reviews ?? []).map((r) => r.campaign.riskLevel ?? "unscored"),
        active: list.filters.risk,
      }),
    [reviews, list.filters.risk],
  );

  async function act(campaignId: string, action: "approve" | "block", body?: unknown) {
    setBusyId(campaignId);
    try {
      await api.post(`/api/admin/campaigns/${campaignId}/${action}`, body ?? {});
      toast.success(action === "approve" ? "Campaign approved" : "Campaign blocked");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="font-display text-2xl sm:text-3xl">Campaign reviews</h1>

      {reviews !== null && reviews.length > 0 && (
        <ListToolbar>
          <ListSearch
            value={list.search}
            onChange={list.setSearch}
            placeholder="Search campaign or account…"
          />
          <ListFilter
            value={list.filters.risk}
            onChange={(v) => list.setFilter("risk", v)}
            options={riskOptions}
            ariaLabel="Filter by risk level"
          />
          <ListClear show={list.isFiltered} onClear={list.clearFilters} />
          <ListCount shown={list.shown} total={list.total} noun="review" className="ml-auto" />
        </ListToolbar>
      )}

      {list.view === null ? (
        <ListSkeleton rows={3} />
      ) : list.isEmpty ? (
        <Card>
          <CardContent>
            <ListEmpty
              icon={CheckCircle2}
              title="Nothing to review"
              description="You're all caught up — no campaigns are waiting for review right now."
            />
          </CardContent>
        </Card>
      ) : list.isFilteredEmpty ? (
        <Card>
          <CardContent>
            <ListNoResults onClear={list.clearFilters} />
          </CardContent>
        </Card>
      ) : (
        list.view.map(({ campaign, accountName, audienceCount }) => (
          <Card key={campaign.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-3 text-base">
                {campaign.name}
                <Badge variant={statusVariant(campaign.status)}>
                  {statusLabel(campaign.status)}
                </Badge>
                {campaign.riskLevel && (
                  <Badge variant={campaign.riskLevel === "medium" ? "secondary" : "destructive"}>
                    risk: {campaign.riskLevel} ({campaign.riskScore})
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid gap-1 text-muted-foreground">
                <span>
                  Account:{" "}
                  <Link
                    href={`/admin/accounts/${campaign.accountId}`}
                    className="text-foreground hover:underline"
                  >
                    {accountName}
                  </Link>
                </span>
                <span>Subject: {campaign.subject}</span>
                <span>
                  From: {campaign.fromName} &lt;{campaign.fromEmail}&gt;
                </span>
                <span>Audience size: {audienceCount}</span>
                {campaign.riskSummary && <span>Risk: {campaign.riskSummary}</span>}
                {campaign.pausedReason && <span>Reason: {campaign.pausedReason}</span>}
              </div>
              <EmailPreview
                htmlBody={campaign.htmlBody}
                theme={campaign.theme}
                className="max-h-64"
                frameClassName="h-56"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={busyId === campaign.id || campaign.status === "sending"}
                  onClick={() => act(campaign.id, "approve")}
                >
                  Approve & send
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busyId === campaign.id || campaign.status === "blocked"}
                  onClick={() => {
                    const reason = window.prompt("Reason for blocking?") ?? undefined;
                    act(campaign.id, "block", { reason });
                  }}
                >
                  Block
                </Button>
              </div>
            </CardContent>
          </Card>
        ))
      )}
    </div>
  );
}
