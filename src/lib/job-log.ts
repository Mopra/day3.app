import type { Db } from "../db/client";
import { jobLogs } from "../db/schema";
import { newId, nowIso } from "./ids";

export async function logJob(
  db: Db,
  input: {
    jobType: string;
    entityType?: string;
    entityId?: string;
    status: "started" | "completed" | "failed" | "skipped";
    error?: string;
    payload?: unknown;
  },
): Promise<void> {
  const now = nowIso();
  try {
    await db.insert(jobLogs).values({
      id: newId("job"),
      jobType: input.jobType,
      entityType: input.entityType,
      entityId: input.entityId,
      status: input.status,
      error: input.error,
      payloadJson: input.payload ? JSON.stringify(input.payload) : null,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    // Job logging must never break the job itself.
    console.error("[job-log] failed to write job log", err);
  }
}
