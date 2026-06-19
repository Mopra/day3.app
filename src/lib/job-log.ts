import type { Db } from "../db/client";
import { jobLogs } from "../db/schema";
import { newId, nowIso } from "./ids";

export async function logJob(
  db: Db,
  input: {
    jobType: string;
    entityType?: string;
    entityId?: string;
    status: "started" | "completed" | "failed" | "skipped" | "dead_letter";
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

// Dead-letter sink: called when a BullMQ job has exhausted DEFAULT_JOB_OPTIONS
// .attempts (see worker/index.ts). The exhausted message would otherwise only
// linger in BullMQ's Redis "failed" set; mirroring it to job_logs with a
// `dead_letter` status makes the lost work observable in Postgres — queryable
// (SELECT … WHERE status='dead_letter') and logged — so an operator can see and
// replay it instead of it silently vanishing.
export async function recordDeadLetter(
  db: Db,
  input: {
    jobType: string;
    jobId?: string;
    attemptsMade: number;
    error?: string;
    payload?: unknown;
  },
): Promise<void> {
  console.error(
    `[dead-letter] job ${input.jobType} (${input.jobId ?? "?"}) exhausted ${input.attemptsMade} attempts: ${input.error ?? "unknown error"}`,
  );
  await logJob(db, {
    jobType: input.jobType,
    status: "dead_letter",
    error: input.error,
    payload: {
      jobId: input.jobId,
      attemptsMade: input.attemptsMade,
      message: input.payload,
    },
  });
}
