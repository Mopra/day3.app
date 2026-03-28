export const dynamic = "force-dynamic";

import { redirect, notFound } from "next/navigation";
import Link from "next/link";
import { getCurrentUserProfile } from "@/server/actions/user";
import { fetchCampaignById } from "@/server/actions/campaigns";
import { getCampaignTaskStats } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DeleteCampaignButton } from "@/components/campaigns/delete-campaign-button";

export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUserProfile();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const campaign = await fetchCampaignById(id);
  if (!campaign) notFound();

  const stats = await getCampaignTaskStats(id);

  return (
    <div className="max-w-2xl space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{campaign.title}</h1>
        <Badge variant={campaign.status === "active" ? "default" : "secondary"}>
          {campaign.status}
        </Badge>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <p className="text-sm text-muted-foreground">Description</p>
            <p className="text-sm">{campaign.description}</p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">Target URL</p>
            <a
              href={campaign.targetUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm underline hover:text-foreground transition-colors"
            >
              {campaign.targetUrl}
            </a>
          </div>
          {campaign.topics?.length > 0 && (
            <div>
              <p className="text-sm text-muted-foreground">Topics</p>
              <div className="flex gap-1 flex-wrap mt-1">
                {campaign.topics.map((t: string) => (
                  <Badge key={t} variant="outline">
                    {t}
                  </Badge>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Task stats</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-3 gap-4 text-sm">
            <div>
              <p className="text-muted-foreground">Budget</p>
              <p className="font-medium">{campaign.budgetCredits} credits</p>
            </div>
            <div>
              <p className="text-muted-foreground">Remaining</p>
              <p className="font-medium">{campaign.remainingCredits} credits</p>
            </div>
            <div>
              <p className="text-muted-foreground">Total tasks</p>
              <p className="font-medium">{stats.total}</p>
            </div>
          </div>
          <div className="flex gap-4 text-xs mt-4">
            <span>Open: {stats.open}</span>
            <span>Claimed: {stats.claimed}</span>
            <span>Submitted: {stats.submitted}</span>
            <span className="text-green-400">Approved: {stats.approved}</span>
            {stats.rejected > 0 && (
              <span className="text-destructive">Rejected: {stats.rejected}</span>
            )}
          </div>
        </CardContent>
      </Card>

      <div className="flex gap-3">
        <Link href={`/campaigns/${id}/edit`}>
          <Button variant="outline">Edit campaign</Button>
        </Link>
        <DeleteCampaignButton campaignId={id} />
        <Link href="/campaigns" className="ml-auto">
          <Button variant="ghost">Back to campaigns</Button>
        </Link>
      </div>
    </div>
  );
}
