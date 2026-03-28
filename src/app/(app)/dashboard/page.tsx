export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUserProfile } from "@/server/actions/user";
import { fetchMyClaimedTasks } from "@/server/actions/tasks";
import { fetchMyPendingSubmissions } from "@/server/actions/campaigns";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ReviewTaskCard } from "@/components/tasks/review-task-card";

export default async function DashboardPage() {
  const user = await getCurrentUserProfile();
  if (!user) redirect("/sign-in");

  const [claimedTasks, pendingSubmissions] = await Promise.all([
    fetchMyClaimedTasks().catch(() => []),
    fetchMyPendingSubmissions().catch(() => []),
  ]);

  return (
    <div className="space-y-8">
      <div className="grid gap-4 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Credits</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{user.credits}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Active tasks</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{claimedTasks.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground">Pending reviews</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{pendingSubmissions.length}</p>
          </CardContent>
        </Card>
      </div>

      {pendingSubmissions.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">
            Tasks awaiting your review ({pendingSubmissions.length})
          </h2>
          <p className="text-sm text-muted-foreground">
            People completed tasks on your campaigns. Review and earn 1 credit per review.
          </p>
          <div className="grid gap-3">
            {pendingSubmissions.map((task) => (
              <ReviewTaskCard key={task.id} task={task} />
            ))}
          </div>
        </div>
      )}

      {claimedTasks.length > 0 ? (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold">Your active tasks</h2>
          <div className="grid gap-3">
            {claimedTasks.map((task) => (
              <Link key={task.id} href={`/tasks/${task.id}`}>
                <Card className="hover:bg-muted/50 transition-colors">
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge variant="outline" className="capitalize">
                          {task.type}
                        </Badge>
                        <span className="text-sm">+{task.creditReward} credits</span>
                      </div>
                      <Badge
                        variant={task.status === "submitted" ? "secondary" : "default"}
                      >
                        {task.status}
                      </Badge>
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </div>
      ) : (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground">
            <p>No active tasks.</p>
            <Link href="/tasks">
              <Button variant="link">Browse available tasks</Button>
            </Link>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
