export const dynamic = "force-dynamic";

import { redirect, notFound } from "next/navigation";
import { getCurrentUserProfile } from "@/server/actions/user";
import { fetchTaskById } from "@/server/actions/tasks";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { TaskActions } from "@/components/tasks/task-actions";

export default async function TaskDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const user = await getCurrentUserProfile();
  if (!user) redirect("/sign-in");

  const task = await fetchTaskById(id);
  if (!task) notFound();

  const isOwner = task.ownerUserId === user.clerkUserId;
  const isClaimer = task.claimedByUserId === user.clerkUserId;

  const statusColors: Record<string, string> = {
    open: "default",
    claimed: "secondary",
    submitted: "secondary",
    approved: "default",
    rejected: "destructive",
  };

  return (
    <div className="max-w-2xl space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="capitalize">{task.type} task</CardTitle>
            <Badge variant={statusColors[task.status] as "default" | "secondary" | "destructive"}>
              {task.status}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="text-sm space-y-2">
            <p>
              <span className="text-muted-foreground">Reward:</span>{" "}
              <span className="font-medium">+{task.creditReward} credits</span>
            </p>
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
          </div>

          <div className="rounded-lg bg-muted/50 p-4">
            <p className="text-sm font-medium mb-1">Instructions</p>
            <p className="text-sm text-muted-foreground">{task.instructions}</p>
          </div>

          {task.proofUrl && (
            <div className="text-sm">
              <span className="text-muted-foreground">Proof URL:</span>{" "}
              <a
                href={task.proofUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="underline hover:text-primary transition-colors"
              >
                {task.proofUrl}
              </a>
            </div>
          )}
          {task.proofText && (
            <div className="text-sm">
              <span className="text-muted-foreground">Notes:</span>{" "}
              {task.proofText}
            </div>
          )}
        </CardContent>
      </Card>

      <TaskActions task={task} isOwner={isOwner} isClaimer={isClaimer} />
    </div>
  );
}
