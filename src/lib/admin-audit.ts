import type { Db } from "../db/client";
import { logJob } from "./job-log";

// Admin mutations are the deliberate exception to account scoping: an operator
// can pause/resume accounts, override domain verification, approve/block
// campaigns, and add suppressions across tenants. Every such action writes an
// audit record to job_logs (jobType "admin_action") capturing WHO (the admin's
// email + Clerk user id), WHAT (the action), WHEN (job_logs.createdAt), and the
// TARGET (entity type + id), so privileged actions are traceable as the operator
// team grows.
export async function logAdminAction(
  db: Db,
  input: {
    action: string;
    actorEmail: string;
    actorUserId: string;
    targetType: string;
    targetId: string;
    details?: Record<string, unknown>;
  },
): Promise<void> {
  await logJob(db, {
    jobType: "admin_action",
    entityType: input.targetType,
    entityId: input.targetId,
    status: "completed",
    payload: {
      action: input.action,
      actorEmail: input.actorEmail,
      actorUserId: input.actorUserId,
      ...input.details,
    },
  });
}
