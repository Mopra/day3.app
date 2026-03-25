"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createCampaignAction } from "@/server/actions/campaigns";
import { CREDIT_VALUES } from "@/lib/types";

export default function NewCampaignPage() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [likeCount, setLikeCount] = useState(0);
  const [replyCount, setReplyCount] = useState(0);
  const [quoteCount, setQuoteCount] = useState(0);

  const totalCost =
    likeCount * CREDIT_VALUES.like +
    replyCount * CREDIT_VALUES.reply +
    quoteCount * CREDIT_VALUES.quote;

  async function handleSubmit(formData: FormData) {
    setLoading(true);
    setError("");
    const result = await createCampaignAction(formData);
    if (!result.success) {
      setError(result.error || "Failed to create campaign");
      setLoading(false);
      return;
    }
    router.push("/campaigns");
  }

  return (
    <div className="max-w-2xl">
      <Card>
        <CardHeader>
          <CardTitle>Create a campaign</CardTitle>
        </CardHeader>
        <CardContent>
          <form action={handleSubmit} className="space-y-6">
            {error && (
              <p className="text-sm text-destructive">{error}</p>
            )}

            <div className="space-y-2">
              <Label htmlFor="title">Title</Label>
              <Input id="title" name="title" placeholder="My campaign" required />
            </div>

            <div className="space-y-2">
              <Label htmlFor="description">Description</Label>
              <Textarea
                id="description"
                name="description"
                placeholder="What do you want promoted?"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="targetUrl">Target URL</Label>
              <Input
                id="targetUrl"
                name="targetUrl"
                placeholder="https://x.com/..."
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="topics">Topics (comma separated)</Label>
              <Input id="topics" name="topics" placeholder="tech, ai, startups" />
            </div>

            <div className="grid grid-cols-3 gap-4">
              <div className="space-y-2">
                <Label htmlFor="likeCount">Likes ({CREDIT_VALUES.like}cr each)</Label>
                <Input
                  id="likeCount"
                  name="likeCount"
                  type="number"
                  min={0}
                  value={likeCount}
                  onChange={(e) => setLikeCount(Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="replyCount">Replies ({CREDIT_VALUES.reply}cr each)</Label>
                <Input
                  id="replyCount"
                  name="replyCount"
                  type="number"
                  min={0}
                  value={replyCount}
                  onChange={(e) => setReplyCount(Number(e.target.value))}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="quoteCount">Quotes ({CREDIT_VALUES.quote}cr each)</Label>
                <Input
                  id="quoteCount"
                  name="quoteCount"
                  type="number"
                  min={0}
                  value={quoteCount}
                  onChange={(e) => setQuoteCount(Number(e.target.value))}
                />
              </div>
            </div>

            <div className="rounded-lg bg-muted/50 p-4 text-sm">
              Total cost: <span className="font-bold">{totalCost} credits</span>
            </div>

            <Button type="submit" disabled={loading || totalCost <= 0}>
              Create campaign
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
