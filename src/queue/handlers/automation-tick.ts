import { and, asc, eq, lte } from "drizzle-orm";
import type { Db } from "../../db/client";
import { automationEnrollments } from "../../db/schema";
import { logJob } from "../../lib/job-log";
import { logger } from "../../lib/logger";
import { advanceEnrollment, newEngineContext } from "../../services/automation-engine";
import { envInt, type JobQueue } from "../messages";

// The 60-second dispatcher (design §5.2, §5.3). Claims due enrollments
// round-robin by account and advances them. It never sends: a send node flips
// the enrollment to `sending` and hands off to send_automation_node, which is
// what keeps a tick sub-second and unable to overrun its own cadence.
//
// Fairness is a property of this loop, not of any rate limit. A plain global
// ORDER BY next_run_at would let one org importing 50,000 contacts occupy every
// tick and starve every other tenant's welcome emails behind it; instead each
// account with due work gets at most AUTOMATION_TICK_PER_ACCOUNT enrollments per
// pass and the loop moves on.

export const AUTOMATION_TICK_PER_ACCOUNT = envInt("AUTOMATION_TICK_PER_ACCOUNT", 2000, 1, 20000);

// Enrollments advanced concurrently within one account. Each advance is a
// handful of small statements; a little parallelism hides the DB round-trip
// without leaning on the worker's connection pool.
const ADVANCE_CONCURRENCY = 10;

// Wall-clock bound on one tick. The tick repeats every minute, so stopping
// early loses nothing: whatever is still due is at the front of the next pass.
export const TICK_DEADLINE_MS = 45_000;

export type AutomationTickDeps = {
  db: Db;
  queue: JobQueue;
  shouldAbort?: () => boolean;
  now?: Date;
};

export type AutomationTickResult = {
  accounts: number;
  advanced: number;
  errors: number;
  deadlineHit: boolean;
};

export async function runAutomationTick(deps: AutomationTickDeps): Promise<AutomationTickResult> {
  const { db, queue } = deps;
  const startedAt = Date.now();
  const nowStr = (deps.now ?? new Date()).toISOString();
  const result: AutomationTickResult = { accounts: 0, advanced: 0, errors: 0, deadlineHit: false };

  // Which accounts have work. Served by the partial (next_run_at) index, which
  // only ever holds live enrollments.
  const accountRows = await db
    .selectDistinct({ accountId: automationEnrollments.accountId })
    .from(automationEnrollments)
    .where(
      and(eq(automationEnrollments.status, "active"), lte(automationEnrollments.nextRunAt, nowStr)),
    );
  if (accountRows.length === 0) return result;

  // One cache for the whole pass: thousands of enrollments share a few
  // automations, and their graphs and account rows do not change in 45 seconds.
  const engine = { queue, ctx: newEngineContext() };
  const overBudget = () => Date.now() - startedAt > TICK_DEADLINE_MS || !!deps.shouldAbort?.();

  outer: for (const { accountId } of accountRows) {
    if (overBudget()) {
      result.deadlineHit = true;
      break;
    }
    result.accounts++;
    const due = await db
      .select({ id: automationEnrollments.id })
      .from(automationEnrollments)
      .where(
        and(
          eq(automationEnrollments.accountId, accountId),
          eq(automationEnrollments.status, "active"),
          lte(automationEnrollments.nextRunAt, nowStr),
        ),
      )
      .orderBy(asc(automationEnrollments.nextRunAt))
      .limit(AUTOMATION_TICK_PER_ACCOUNT);

    for (let i = 0; i < due.length; i += ADVANCE_CONCURRENCY) {
      if (overBudget()) {
        result.deadlineHit = true;
        break outer;
      }
      const chunk = due.slice(i, i + ADVANCE_CONCURRENCY);
      const outcomes = await Promise.all(
        chunk.map(async ({ id }) => {
          try {
            return await advanceEnrollment(db, engine, id);
          } catch (err) {
            // One poison enrollment must not stop the pass; it is retried next
            // tick and its error is on record here.
            void logger.reportError("automation advance failed in tick", err, {
              enrollmentId: id,
              accountId,
            });
            return "error" as const;
          }
        }),
      );
      for (const o of outcomes) {
        if (o === "error") result.errors++;
        else if (o !== "not_due") result.advanced++;
      }
    }
  }

  // Quiet ticks leave no job_logs row: at one a minute they would be most of
  // the table. A pass that moved something (or failed) is worth recording.
  if (result.advanced > 0 || result.errors > 0) {
    await logJob(db, {
      jobType: "automation_tick",
      status: result.errors > 0 ? "failed" : "completed",
      error: result.errors > 0 ? `${result.errors} enrollment(s) failed to advance` : undefined,
      payload: { ...result, durationMs: Date.now() - startedAt },
    });
  }
  return result;
}
