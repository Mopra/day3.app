"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { approveTaskAction, rejectTaskAction } from "@/server/actions/campaigns";
import type { CampaignTask } from "@/lib/types";

export function ReviewTaskCard({ task }: { task: CampaignTask }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);

  async function handleApprove() {
    setLoading(true);
    await approveTaskAction(task.id);
    router.refresh();
  }

  async function handleReject() {
    setLoading(true);
    await rejectTaskAction(task.id);
    router.refresh();
  }

  return (
    <Card>
      <CardContent className="py-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Badge variant="outline" className="capitalize">
              {task.type}
            </Badge>
            <span className="text-sm font-medium">+{task.creditReward} credits</span>
          </div>
          <span className="text-xs text-muted-foreground">
            Submitter: {task.claimedByUserId?.slice(0, 12)}...
          </span>
        </div>

        <div className="text-sm space-y-1">
          <p>
            <span className="text-muted-foreground">Target:</span>{" "}
            <a
              href={task.targetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="underline hover:text-primary transition-colors"
            >
              {task.targetUrl}
            </a>
          </p>
          {task.proofUrl && (
            <p>
              <span className="text-muted-foreground">Proof URL:</span>{" "}
              <a
                href={task.proofUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-primary transition-colors"
              >
                {task.proofUrl}
              </a>
            </p>
          )}
          {task.proofText && (
            <p>
              <span className="text-muted-foreground">Notes:</span>{" "}
              {task.proofText}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between">
          <div className="flex gap-2">
            <Button size="sm" onClick={handleApprove} disabled={loading}>
              Approve
            </Button>
            <Button size="sm" variant="destructive" onClick={handleReject} disabled={loading}>
              Reject
            </Button>
          </div>
          <span className="text-xs text-muted-foreground">
            You earn 1 credit for reviewing
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
