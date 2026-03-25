export const dynamic = "force-dynamic";

import { redirect } from "next/navigation";
import Link from "next/link";
import { getCurrentUserProfile } from "@/server/actions/user";
import { getOpenTasks } from "@/server/actions/tasks";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export default async function TasksPage() {
  const user = await getCurrentUserProfile();
  if (!user) redirect("/onboarding");

  const tasks = await getOpenTasks();

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold tracking-tight">Available tasks</h2>
        <p className="text-muted-foreground">
          Claim a task, complete it, and earn credits.
        </p>
      </div>

      {tasks.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            No tasks available right now. Check back later!
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-3">
          {tasks.map((task) => (
            <Link key={task.id} href={`/tasks/${task.id}`}>
              <Card className="hover:bg-muted/50 transition-colors">
                <CardContent className="py-4">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <Badge variant="outline" className="capitalize">
                        {task.type}
                      </Badge>
                      <span className="text-sm font-medium">
                        +{task.creditReward} credits
                      </span>
                    </div>
                    <span className="text-xs text-muted-foreground truncate max-w-[200px]">
                      {task.targetUrl}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-2">
                    {task.instructions}
                  </p>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
