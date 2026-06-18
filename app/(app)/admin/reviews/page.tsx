"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
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
      <h1 className="text-2xl font-semibold tracking-tight">Campaign reviews</h1>

      {reviews === null ? (
        <Skeleton className="h-32 w-full" />
      ) : reviews.length === 0 ? (
        <Card>
          <CardContent>
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nothing needs review right now.
            </p>
          </CardContent>
        </Card>
      ) : (
        reviews.map(({ campaign, accountName, audienceCount }) => (
          <Card key={campaign.id}>
            <CardHeader>
              <CardTitle className="flex items-center gap-3 text-base">
                {campaign.name}
                <Badge variant={statusVariant(campaign.status)}>
                  {statusLabel(campaign.status)}
                </Badge>
                {campaign.riskLevel && (
                  <Badge
                    variant={campaign.riskLevel === "medium" ? "secondary" : "destructive"}
                  >
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
              <div className="max-h-64 overflow-auto rounded-lg border border-border bg-white p-3">
                <iframe
                  title={`Preview ${campaign.id}`}
                  sandbox=""
                  srcDoc={campaign.htmlBody}
                  className="h-56 w-full border-0"
                />
              </div>
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
