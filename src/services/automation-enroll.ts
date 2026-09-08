import { and, eq, inArray, isNull, isNotNull, or } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  automationEnrollments,
  automationNodes,
  automations,
  subscribers,
  type Automation,
} from "../db/schema";
import type { EnrollOutcome, EnrollResult } from "../lib/automation-types";
import { canonicalizeEmail } from "../lib/csv";
import { newId, nowIso } from "../lib/ids";
import { logger } from "../lib/logger";
import { safeParseSegmentFilter, segmentFilterCondition } from "../lib/segment-filter";
import { enqueueBestEffort } from "../queue/enqueue";
import type { JobQueue } from "../queue/messages";
import { orgMemberEmails } from "./sandbox";
import { getSuppressedEmails } from "./suppression";

// Enrollment: the one way a subscriber enters an automation. Every trigger
// (audience join from a form, confirm, import, manual add, v1 contacts), the
// manual enroll button and POST /v1/automations/{id}/enroll all end up in
// enrollBatch below, so the entry gates have exactly one implementation.
//
// Re-entry is not checked here. It is enforced by the two partial unique
// indexes on automation_enrollments (design §3.2): the insert simply does
// nothing on a conflict, which is what turns "already enrolled" from a
// check-then-insert race into a fact the database guarantees.

export type EnrollSource = "audience_join" | "api" | "manual";

export type EnrollInput = {
  automation: Automation;
  subscriberId: string;
  source: EnrollSource;
};

// Subscribers are loaded and filtered in chunks; a CSV import can hand over
// tens of thousands of ids at once.
const CHUNK = 500;

// Immediate advance jobs enqueued per batch. Beyond this the tick (every 60s,
// 2,000 per account per pass) is the faster path anyway, and a 50,000-row
// import should not spend a minute adding Redis jobs one by one.
const IMMEDIATE_ENQUEUE_MAX = 500;

// Enrolls one subscriber into one automation on its live version. Applies every
// entry gate (automation active, subscriber `subscribed` in the automation's
// audience, not suppressed, entry filter, sandbox membership, re-entry mode) and
// returns the outcome. On `enrolled` the row exists with next_run_at = now, and
// an immediate advance job has been enqueued when `queue` is given.
export async function enrollSubscriber(
  db: Db,
  queue: JobQueue | null,
  input: EnrollInput,
): Promise<EnrollResult> {
  const results = await enrollBatch(db, queue, input.automation, [input.subscriberId], input.source);
  return results.get(input.subscriberId) ?? { outcome: "wrong_audience", enrollmentId: null };
}

// The audience-join trigger hook. Called from every code path that makes a
// subscriber `subscribed` in an audience (form signup / confirm, manual add,
// CSV import, v1 contacts). Finds the live `audience_join` automations for the
// audience and enrolls each subscriber. MUST NEVER THROW: a trigger failure
// must not fail the signup that caused it. Errors are logged.
//
// `queue` may be null on call sites that hold no queue (the web tier's route
// handlers, the import job); the enqueue then goes through the ambient
// best-effort queue, which is the same connection that tier already holds.
export async function enrollAudienceJoin(
  db: Db,
  queue: JobQueue | null,
  input: { accountId: string; audienceId: string; subscriberIds: string[]; formId?: string | null },
): Promise<void> {
  if (input.subscriberIds.length === 0) return;
  try {
    const candidates = await db
      .select()
      .from(automations)
      .where(
        and(
          eq(automations.accountId, input.accountId),
          eq(automations.audienceId, input.audienceId),
          eq(automations.triggerKind, "audience_join"),
          eq(automations.status, "active"),
          isNotNull(automations.liveVersionId),
          // A form-narrowed trigger only fires for signups from that form; a
          // manual add or an import carries no form and skips it.
          input.formId
            ? or(isNull(automations.triggerFormId), eq(automations.triggerFormId, input.formId))
            : isNull(automations.triggerFormId),
        ),
      );
    if (candidates.length === 0) return;
    const effectiveQueue = queue ?? ambientQueue;
    for (const automation of candidates) {
      try {
        await enrollBatch(db, effectiveQueue, automation, input.subscriberIds, "audience_join");
      } catch (err) {
        void logger.reportError("audience-join enrollment failed", err, {
          automationId: automation.id,
          accountId: input.accountId,
        });
      }
    }
  } catch (err) {
    void logger.reportError("audience-join trigger lookup failed", err, {
      accountId: input.accountId,
      audienceId: input.audienceId,
    });
  }
}

// The web tier and the import job have no JobQueue in scope; enqueueBestEffort
// reaches the tier's own connection (worker: the registered ambient queue; web:
// the lazy producer) and never throws, which is the right shape for a trigger
// side effect whose real work (the subscriber write) has already committed.
const ambientQueue: JobQueue = {
  async send(message, opts) {
    await enqueueBestEffort(message, opts);
  },
};

// The shared gate + insert path. Returns one result per requested subscriber
// id (unknown ids come back as wrong_audience).
export async function enrollBatch(
  db: Db,
  queue: JobQueue | null,
  automation: Automation,
  subscriberIds: string[],
  source: EnrollSource,
): Promise<Map<string, EnrollResult>> {
  const results = new Map<string, EnrollResult>();
  const ids = [...new Set(subscriberIds)];
  const fail = (id: string, outcome: EnrollOutcome) => results.set(id, { outcome, enrollmentId: null });

  if (automation.status !== "active" || !automation.liveVersionId) {
    for (const id of ids) fail(id, "automation_not_active");
    return results;
  }
  const liveVersionId = automation.liveVersionId;

  // The cursor every enrollment starts on. A published version always has
  // exactly one trigger (validateGraph enforces it); its absence means the
  // version rows are missing, which is not a state anyone should enter.
  const [trigger] = await db
    .select({ key: automationNodes.key })
    .from(automationNodes)
    .where(
      and(
        eq(automationNodes.accountId, automation.accountId),
        eq(automationNodes.automationVersionId, liveVersionId),
        eq(automationNodes.kind, "trigger"),
      ),
    )
    .limit(1);
  if (!trigger) {
    logger.warn("automation live version has no trigger node; refusing to enroll", {
      automationId: automation.id,
      versionId: liveVersionId,
    });
    for (const id of ids) fail(id, "automation_not_active");
    return results;
  }

  const entryFilter = automation.entryFilterJson
    ? safeParseSegmentFilter(automation.entryFilterJson)
    : null;
  if (automation.entryFilterJson && !entryFilter) {
    // A corrupt stored filter must never widen to "everyone": fail closed.
    logger.warn("automation entry filter failed to parse; enrolling nobody", {
      automationId: automation.id,
    });
    for (const id of ids) fail(id, "entry_filter_no_match");
    return results;
  }

  const members = automation.sandbox ? await orgMemberEmails(db, automation.accountId) : null;

  const toInsert: { subscriberId: string }[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await db
      .select({
        id: subscribers.id,
        email: subscribers.email,
        status: subscribers.status,
        audienceId: subscribers.audienceId,
      })
      .from(subscribers)
      .where(and(eq(subscribers.accountId, automation.accountId), inArray(subscribers.id, chunk)));
    const byId = new Map(rows.map((r) => [r.id, r]));

    const candidates: typeof rows = [];
    for (const id of chunk) {
      const sub = byId.get(id);
      if (!sub || sub.audienceId !== automation.audienceId) fail(id, "wrong_audience");
      else if (sub.status !== "subscribed") fail(id, "not_subscribed");
      else candidates.push(sub);
    }
    if (candidates.length === 0) continue;

    const suppressed = await getSuppressedEmails(
      db,
      automation.accountId,
      candidates.map((c) => c.email),
    );
    const unsuppressed = candidates.filter((c) => {
      if (suppressed.has(canonicalizeEmail(c.email))) {
        fail(c.id, "suppressed");
        return false;
      }
      return true;
    });
    if (unsuppressed.length === 0) continue;

    let matching = unsuppressed;
    if (entryFilter) {
      const hits = await db
        .select({ id: subscribers.id })
        .from(subscribers)
        .where(
          and(
            eq(subscribers.accountId, automation.accountId),
            inArray(
              subscribers.id,
              unsuppressed.map((c) => c.id),
            ),
            segmentFilterCondition(entryFilter),
          ),
        );
      const hitIds = new Set(hits.map((h) => h.id));
      matching = unsuppressed.filter((c) => {
        if (hitIds.has(c.id)) return true;
        fail(c.id, "entry_filter_no_match");
        return false;
      });
    }

    for (const c of matching) {
      if (members && !members.has(canonicalizeEmail(c.email))) {
        fail(c.id, "sandbox_not_member");
        continue;
      }
      toInsert.push({ subscriberId: c.id });
    }
  }

  const now = nowIso();
  const inserted: { id: string; subscriberId: string }[] = [];
  for (let i = 0; i < toInsert.length; i += CHUNK) {
    const chunk = toInsert.slice(i, i + CHUNK);
    // ON CONFLICT DO NOTHING with no target covers both partial unique indexes,
    // so `once` and `once_at_a_time` are enforced by the same statement and
    // `always` (no index) simply inserts.
    const rows = await db
      .insert(automationEnrollments)
      .values(
        chunk.map((c) => ({
          id: newId("aen"),
          accountId: automation.accountId,
          automationId: automation.id,
          automationVersionId: liveVersionId,
          subscriberId: c.subscriberId,
          status: "active" as const,
          reentryMode: automation.reentry,
          currentNodeKey: trigger.key,
          nextRunAt: now,
          lockedAt: null,
          visitCount: 0,
          sendCount: 0,
          sandbox: automation.sandbox,
          enteredAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: automationEnrollments.id, subscriberId: automationEnrollments.subscriberId });
    inserted.push(...rows);
  }

  const insertedBySubscriber = new Map(inserted.map((r) => [r.subscriberId, r.id]));
  for (const c of toInsert) {
    const enrollmentId = insertedBySubscriber.get(c.subscriberId);
    results.set(
      c.subscriberId,
      enrollmentId
        ? { outcome: "enrolled", enrollmentId }
        : { outcome: "already_enrolled", enrollmentId: null },
    );
  }

  // The immediate path: a zero-wait welcome email leaves in seconds instead of
  // on the next tick. Best-effort by construction; the row is already active
  // and due, so the tick is the durable backstop for any enqueue that fails.
  if (queue && inserted.length > 0) {
    for (const row of inserted.slice(0, IMMEDIATE_ENQUEUE_MAX)) {
      try {
        await queue.send({
          type: "advance_automation_enrollment",
          enrollmentId: row.id,
          accountId: automation.accountId,
        });
      } catch (err) {
        logger.warn("advance enqueue after enrollment failed (tick will pick it up)", {
          enrollmentId: row.id,
          automationId: automation.id,
          source,
          error: err instanceof Error ? err.message : String(err),
        });
        break; // one Redis failure is not five hundred
      }
    }
  }

  return results;
}
