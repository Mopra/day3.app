export const dynamic = "force-dynamic";

import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentUserProfile } from "@/server/actions/user";
import { fetchMyCampaigns, fetchMyPendingSubmissions } from "@/server/actions/campaigns";
import { getCampaignTaskStats } from "@/lib/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ReviewTaskCard } from "@/components/tasks/review-task-card";

export default async function CampaignsPage() {
  const user = await getCurrentUserProfile();
  if (!user) redirect("/onboarding");

  const [campaigns, pendingSubmissions] = await Promise.all([
    fetchMyCampaigns().catch(() => []),
    fetchMyPendingSubmissions(),
  ]);

  const campaignsWithStats = await Promise.all(
    campaigns.map(async (c) => {
      const stats = await getCampaignTaskStats(c.id);
      return { ...c, stats };
    })
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <Link href="/campaigns/new">
          <Button>Create campaign</Button>
        </Link>
      </div>

      {pendingSubmissions.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">
            Pending reviews ({pendingSubmissions.length})
          </h2>
          <p className="text-sm text-muted-foreground">
            Tasks submitted on your campaigns awaiting your approval. You earn 1 credit per review.
          </p>
          <div className="grid gap-3">
            {pendingSubmissions.map((task) => (
              <ReviewTaskCard key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}

      {campaignsWithStats.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No campaigns yet. Earn credits by completing tasks, then create your
            first campaign to get promoted.
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4">
          {campaignsWithStats.map((c) => (
            <Link key={c.id} href={`/campaigns/${c.id}`}>
              <Card className="hover:bg-muted/50 transition-colors cursor-pointer">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-lg">{c.title}</CardTitle>
                    <Badge variant={c.status === "active" ? "default" : "secondary"}>
                      {c.status}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    {c.description}
                  </p>
                  <div className="flex gap-6 text-sm">
                    <div>
                      <span className="text-muted-foreground">Budget:</span>{" "}
                      <span className="font-medium">{c.budgetCredits} credits</span>
                    </div>
                    <div>
                      <span className="text-muted-foreground">Total tasks:</span>{" "}
                      <span className="font-medium">{c.stats.total}</span>
                    </div>
                  </div>
                  <div className="flex gap-4 text-xs">
                    <span>Open: {c.stats.open}</span>
                    <span>Claimed: {c.stats.claimed}</span>
                    <span>Submitted: {c.stats.submitted}</span>
                    <span className="text-green-400">Approved: {c.stats.approved}</span>
                    {c.stats.rejected > 0 && (
                      <span className="text-destructive">Rejected: {c.stats.rejected}</span>
                    )}
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
