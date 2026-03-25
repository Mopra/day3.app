"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { claimTaskAction, submitProofAction } from "@/server/actions/tasks";
import type { CampaignTask } from "@/lib/types";

export function TaskActions({
  task,
  isOwner,
  isClaimer,
}: {
  task: CampaignTask;
  isOwner: boolean;
  isClaimer: boolean;
}) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [proofUrl, setProofUrl] = useState("");
  const [proofText, setProofText] = useState("");

  async function handleClaim() {
    setLoading(true);
    setError("");
    const result = await claimTaskAction(task.id);
    if (!result.success) {
      setError(result.error || "Failed to claim task");
      setLoading(false);
      return;
    }
    router.refresh();
  }

  async function handleSubmitProof() {
    setLoading(true);
    setError("");
    try {
      const result = await submitProofAction(task.id, proofUrl, proofText);
      if (!result.success) {
        setError(result.error || "Failed to submit proof");
        setLoading(false);
        return;
      }
      router.refresh();
    } catch {
      setError("Something went wrong. Please try again.");
      setLoading(false);
    }
  }

  if (task.status === "approved") {
    return (
      <div className="rounded-lg border border-green-500/30 bg-green-500/10 p-4 text-sm text-green-400">
        Task approved! Credits have been awarded.
      </div>
    );
  }

  if (task.status === "rejected") {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
        Task was rejected by the campaign owner.
      </div>
    );
  }

  if (task.status === "submitted") {
    return (
      <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4 text-sm text-yellow-400">
        Waiting for the campaign owner to review your submission.
      </div>
    );
  }

  if (task.status === "claimed" && isClaimer) {
    return (
      <div className="space-y-4">
        <h3 className="font-medium">Submit proof</h3>
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        <div className="space-y-2">
          <Label htmlFor="proofUrl">
            {task.type === "like" ? "Screenshot URL (optional)" : "Proof URL"}
          </Label>
          <Input
            id="proofUrl"
            placeholder={task.type === "like" ? "Link to screenshot of your like..." : "https://x.com/..."}
            value={proofUrl}
            onChange={(e) => setProofUrl(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="proofText">Notes</Label>
          <Textarea
            id="proofText"
            placeholder="Any additional notes..."
            value={proofText}
            onChange={(e) => setProofText(e.target.value)}
          />
        </div>
        <Button onClick={handleSubmitProof} disabled={loading}>
          Submit proof
        </Button>
      </div>
    );
  }

  if (task.status === "open" && !isOwner) {
    return (
      <div className="space-y-3">
        {error && (
          <p className="text-sm text-destructive">{error}</p>
        )}
        <Button onClick={handleClaim} disabled={loading}>
          Claim this task
        </Button>
      </div>
    );
  }

  if (isOwner) {
    return (
      <div className="rounded-lg border p-4 text-sm text-muted-foreground">
        This is your campaign&apos;s task. You cannot claim your own tasks.
      </div>
    );
  }

  return null;
}
