"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { updateCampaignAction } from "@/server/actions/campaigns";
import type { Campaign } from "@/lib/types";

export function EditCampaignForm({ campaign }: { campaign: Campaign }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState(campaign.status);

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    formData.set("status", status);
    const result = await updateCampaignAction(campaign.id, formData);
    if (!result.success) {
      setError(result.error || "Failed to update campaign");
      setLoading(false);
      return;
    }
    router.push(`/campaigns/${campaign.id}`);
    router.refresh();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Edit campaign</CardTitle>
      </CardHeader>
      <CardContent>
        <form action={handleSubmit} className="space-y-6">
          {error && (
            <p className="text-sm text-destructive">{error}</p>
          )}

          <div className="space-y-2">
            <Label htmlFor="title">Title</Label>
            <Input
              id="title"
              name="title"
              defaultValue={campaign.title}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              name="description"
              defaultValue={campaign.description}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="targetUrl">Target URL</Label>
            <Input
              id="targetUrl"
              name="targetUrl"
              defaultValue={campaign.targetUrl}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="topics">Topics (comma separated)</Label>
            <Input
              id="topics"
              name="topics"
              defaultValue={campaign.topics?.join(", ") ?? ""}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="status">Status</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as typeof status)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="active">Active</SelectItem>
                <SelectItem value="paused">Paused</SelectItem>
                <SelectItem value="completed">Completed</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex gap-3">
            <Button type="submit" disabled={loading}>
              {loading ? "Saving..." : "Save changes"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              onClick={() => router.push(`/campaigns/${campaign.id}`)}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
