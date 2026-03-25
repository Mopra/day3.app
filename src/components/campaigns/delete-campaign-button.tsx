"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { deleteCampaignAction } from "@/server/actions/campaigns";

export function DeleteCampaignButton({ campaignId }: { campaignId: string }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleDelete() {
    if (!confirm("Delete this campaign? Open tasks will be removed and remaining credits refunded.")) {
      return;
    }
    setLoading(true);
    setError("");
    const result = await deleteCampaignAction(campaignId);
    if (!result.success) {
      setError(result.error || "Failed to delete");
      setLoading(false);
      return;
    }
    router.push("/campaigns");
    router.refresh();
  }

  return (
    <div>
      <Button
        variant="destructive"
        onClick={handleDelete}
        disabled={loading}
      >
        {loading ? "Deleting..." : "Delete campaign"}
      </Button>
      {error && <p className="text-sm text-destructive mt-1">{error}</p>}
    </div>
  );
}
