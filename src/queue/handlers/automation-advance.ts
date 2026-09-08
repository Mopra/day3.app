import type { Db } from "../../db/client";
import { advanceEnrollment, newEngineContext } from "../../services/automation-engine";
import type { JobQueue } from "../messages";

// The immediate path after an enrollment, a "run now", or a finished send node:
// advance this one enrollment right away instead of waiting for the tick.
// Idempotent by construction: advanceEnrollment claims the row only if it is
// active and due, so a duplicate job, a retry, or an overlap with the tick is a
// no-op rather than a second step.
export async function advanceAutomationEnrollment(
  message: { enrollmentId: string; accountId: string },
  deps: { db: Db; queue: JobQueue },
): Promise<void> {
  await advanceEnrollment(deps.db, { queue: deps.queue, ctx: newEngineContext() }, message.enrollmentId);
}
