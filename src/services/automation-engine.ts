import { and, eq, gt, lte, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  accounts,
  automationEdges,
  automationEnrollments,
  automationNodes,
  automations,
  campaignRecipients,
  notifications,
  subscribers,
  type Account,
  type Automation,
  type AutomationEnrollment,
  type AutomationExitReason,
  type NotificationKind,
  type Subscriber,
} from "../db/schema";
import {
  BranchNodeConfigSchema,
  DEFAULT_SEND_CAP,
  DEFAULT_VISIT_CAP,
  WaitNodeConfigSchema,
  findNode,
  nextNodeKey,
  waitMillis,
  type AutomationGraph,
  type AutomationGraphNode,
  type NodePort,
} from "../lib/automation-graph";
import type { SendWindow } from "../lib/automation-types";
import { newId, nowIso } from "../lib/ids";
import { logger } from "../lib/logger";
import { safeParseSegmentFilter, segmentFilterCondition } from "../lib/segment-filter";
import type { JobQueue } from "../queue/messages";
import { notifyAccount } from "./notifications";
import { isEmailSuppressed } from "./suppression";

// The automation execution engine (docs/automations-design.md §5). One
// enrollment is a cursor on one node of its pinned version; this module moves
// that cursor. Every transition is its own committed UPDATE, guarded by a
// compare-and-swap on the values the caller read, so two workers that both
// picked up the same enrollment (the immediate post-enrollment job and the
// 60-second tick overlap by design) can never both apply a step: the loser's
// UPDATE matches zero rows and it stops. That guard is what makes the engine
// safe under BullMQ retries without any Redis-side locking.
//
// Sending is the one thing the engine never does inline. A send node flips the
// enrollment to `sending` and hands off to the send_automation_node job, which
// writes the shared send ledger and moves the cursor when it is done.

// Cheap node kinds (trigger, wait, branch) chain inline within one call so a
// branch-into-branch-into-send resolves in one pass. The bound keeps one
// enrollment from monopolising a tick; the remainder is picked up next tick
// (or by the advance job enqueued at the cut).
export const MAX_INLINE_STEPS = 25;

// How long a held enrollment (quota exhausted, billing lapsed, risk pause)
// waits before it is looked at again, and how long a hold may last before the
// node is skipped as too stale (§5.6). A late welcome email is recoverable; a
// month of stale onboarding blasted at everyone after an upgrade is not.
export const HOLD_RETRY_MS = 60 * 60 * 1000;
export const HOLD_STALE_MS = 7 * 24 * 60 * 60 * 1000;
export const TOO_STALE_REASON = "too_stale";

// A paused automation is re-checked more often than a quota hold: resuming is a
// deliberate click the customer is watching, so the wait to see movement should
// be minutes, not an hour.
export const PAUSED_RETRY_MS = 5 * 60 * 1000;

// The notifications.kind value for a loop-guard exit.
export const LOOP_GUARD_NOTIFICATION_KIND: NotificationKind = "automation_loop_guard";

export type EngineDeps = {
  queue: JobQueue;
  // Per-call caches for rows that do not change during a pass (a tick advances
  // thousands of enrollments of the same few automations). Never shared across
  // jobs; newEngineContext() per tick / per advance job.
  ctx?: EngineContext;
};

export type EngineContext = {
  automations: Map<string, Promise<Automation | undefined>>;
  graphs: Map<string, Promise<AutomationGraph>>;
  accounts: Map<string, Promise<Account | undefined>>;
};

export function newEngineContext(): EngineContext {
  return { automations: new Map(), graphs: new Map(), accounts: new Map() };
}

export type AdvanceOutcome =
  | "not_due" // not active, or next_run_at in the future: nothing to do (retry-safe no-op)
  | "lost_race" // another worker applied this step first
  | "waiting" // moved onto a wait node; next_run_at is in the future
  | "sending" // handed to send_automation_node
  | "deferred" // inline step bound reached; an advance job was enqueued
  | "held" // §5.6 hold: account cannot send right now
  | "completed"
  | "exited"
  | "failed";

/* ─────────────────────────────── loading ─────────────────────────────── */

export async function loadVersionGraph(
  db: Db,
  accountId: string,
  versionId: string,
): Promise<AutomationGraph> {
  const nodes = await db
    .select()
    .from(automationNodes)
    .where(
      and(eq(automationNodes.accountId, accountId), eq(automationNodes.automationVersionId, versionId)),
    );
  const edges = await db
    .select()
    .from(automationEdges)
    .where(
      and(eq(automationEdges.accountId, accountId), eq(automationEdges.automationVersionId, versionId)),
    );
  return {
    nodes: nodes.map((n) => ({
      key: n.key,
      kind: n.kind,
      config: parseJsonOrEmpty(n.configJson),
      label: n.label,
    })),
    edges: edges.map((e) => ({ fromKey: e.fromNodeKey, port: e.port as NodePort, toKey: e.toNodeKey })),
  };
}

function parseJsonOrEmpty(json: string | null): unknown {
  if (!json) return {};
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function cached<T>(map: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = map.get(key);
  if (!p) {
    p = load();
    map.set(key, p);
  }
  return p;
}

export function loadAutomation(
  db: Db,
  deps: EngineDeps,
  accountId: string,
  automationId: string,
): Promise<Automation | undefined> {
  const load = () =>
    db.query.automations.findFirst({
      where: and(eq(automations.id, automationId), eq(automations.accountId, accountId)),
    });
  return deps.ctx ? cached(deps.ctx.automations, automationId, load) : load();
}

export function loadGraph(
  db: Db,
  deps: EngineDeps,
  accountId: string,
  versionId: string,
): Promise<AutomationGraph> {
  const load = () => loadVersionGraph(db, accountId, versionId);
  return deps.ctx ? cached(deps.ctx.graphs, versionId, load) : load();
}

export function loadAccount(db: Db, deps: EngineDeps, accountId: string): Promise<Account | undefined> {
  const load = () => db.query.accounts.findFirst({ where: eq(accounts.id, accountId) });
  return deps.ctx ? cached(deps.ctx.accounts, accountId, load) : load();
}

/* ─────────────────────────── row transitions ──────────────────────────── */

type EnrollmentPatch = Partial<typeof automationEnrollments.$inferInsert>;

// The compare-and-swap every write goes through. (status, current_node_key,
// visit_count) is the fencing token: every cursor move bumps visit_count, every
// hand-off changes status, so a stale writer can never overwrite a fresher
// step. Returns the row as written, or null when the token no longer matched.
export async function casEnrollment(
  db: Db,
  row: AutomationEnrollment,
  patch: EnrollmentPatch,
): Promise<AutomationEnrollment | null> {
  const [updated] = await db
    .update(automationEnrollments)
    .set({ ...patch, updatedAt: nowIso() })
    .where(
      and(
        eq(automationEnrollments.id, row.id),
        eq(automationEnrollments.status, row.status),
        eq(automationEnrollments.visitCount, row.visitCount),
        sql`${automationEnrollments.currentNodeKey} is not distinct from ${row.currentNodeKey}`,
      ),
    )
    .returning();
  return updated ?? null;
}

export async function exitEnrollment(
  db: Db,
  row: AutomationEnrollment,
  reason: AutomationExitReason,
): Promise<AutomationEnrollment | null> {
  return casEnrollment(db, row, {
    status: "exited",
    exitedAt: nowIso(),
    exitReason: reason,
    lockedAt: null,
  });
}

export async function failEnrollment(
  db: Db,
  row: AutomationEnrollment,
  error: string,
): Promise<AutomationEnrollment | null> {
  return casEnrollment(db, row, { status: "failed", lastError: error, lockedAt: null });
}

// The §5.6 hold: park the enrollment without advancing it. heldSince is stamped
// on the FIRST hold only, so the staleness cutoff measures the whole hold, not
// the latest retry. Works from `active` (engine) and from `sending` (the send
// handler found the quota gone), returning the row to active either way.
export async function holdEnrollment(
  db: Db,
  row: AutomationEnrollment,
  reason: string,
  retryMs: number,
  now: Date = new Date(),
): Promise<AutomationEnrollment | null> {
  return casEnrollment(db, row, {
    status: "active",
    holdReason: reason,
    heldSince: row.heldSince ?? now.toISOString(),
    nextRunAt: new Date(now.getTime() + retryMs).toISOString(),
    lockedAt: null,
  });
}

export function holdIsStale(row: AutomationEnrollment, now: Date = new Date()): boolean {
  return !!row.heldSince && now.getTime() - Date.parse(row.heldSince) > HOLD_STALE_MS;
}

/* ─────────────────────────────── routing ─────────────────────────────── */

// Where the cursor lands after leaving `fromKey` via `port`, and when it is
// next due there. Both the engine and the send handler move the cursor with
// this, so a wait node gets its due time stamped at ARRIVAL wherever the
// arrival comes from. That matters: the engine reads "cursor on a wait node
// and due" as "the wait elapsed, follow next", so a cursor placed on a wait
// node with next_run_at = now would skip the wait entirely.
//
// An `end` node never becomes the cursor: arriving there completes the
// enrollment (with the end key recorded so the canvas can badge it).
export type Arrival =
  | { kind: "complete"; endKey: string | null }
  | { kind: "move"; currentNodeKey: string; nextRunAt: string };

export function arrivalFor(
  graph: AutomationGraph,
  automation: Pick<Automation, "sendWindowJson" | "timezone">,
  fromKey: string,
  port: NodePort,
  now: Date,
): Arrival {
  const nextKey = nextNodeKey(graph, fromKey, port);
  if (!nextKey) return { kind: "complete", endKey: null };
  const node = findNode(graph, nextKey);
  if (!node) return { kind: "complete", endKey: null };
  if (node.kind === "end") return { kind: "complete", endKey: node.key };
  if (node.kind === "wait") {
    const parsed = WaitNodeConfigSchema.safeParse(node.config ?? {});
    // Publish validates every config, so a wait that fails to parse can only
    // be a hand-edited row; treating it as a zero wait keeps the flow moving.
    if (parsed.success) {
      let due = new Date(now.getTime() + waitMillis(parsed.data));
      if (parsed.data.clampToSendWindow) {
        const window = parseSendWindow(automation.sendWindowJson);
        if (window) due = nextWindowOpen(due, window, automation.timezone);
      }
      return { kind: "move", currentNodeKey: nextKey, nextRunAt: due.toISOString() };
    }
  }
  return { kind: "move", currentNodeKey: nextKey, nextRunAt: now.toISOString() };
}

// Applies an arrival to the row: completion, or a cursor move with the visit
// counted. `extra` carries the caller's own bookkeeping (a send handler adds
// sendCount and clears lockedAt) into the same statement, so the send and its
// cursor move commit as one write.
export async function applyArrival(
  db: Db,
  row: AutomationEnrollment,
  arrival: Arrival,
  extra: EnrollmentPatch = {},
): Promise<AutomationEnrollment | null> {
  if (arrival.kind === "complete") {
    return casEnrollment(db, row, {
      status: "completed",
      completedAt: nowIso(),
      currentNodeKey: arrival.endKey ?? row.currentNodeKey,
      lockedAt: null,
      holdReason: null,
      heldSince: null,
      ...extra,
    });
  }
  return casEnrollment(db, row, {
    status: "active",
    currentNodeKey: arrival.currentNodeKey,
    nextRunAt: arrival.nextRunAt,
    visitCount: row.visitCount + 1,
    lockedAt: null,
    holdReason: null,
    heldSince: null,
    ...extra,
  });
}

/* ───────────────────────────── send window ────────────────────────────── */

export function parseSendWindow(json: string | null): SendWindow | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Partial<SendWindow>;
    if (
      !Array.isArray(parsed.days) ||
      typeof parsed.from !== "string" ||
      typeof parsed.to !== "string"
    ) {
      return null;
    }
    const days = parsed.days.filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
    if (days.length === 0) return null;
    return { days, from: parsed.from, to: parsed.to };
  } catch {
    return null;
  }
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat | null {
  let f = formatterCache.get(timeZone);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone,
        hourCycle: "h23",
        weekday: "short",
        year: "numeric",
        month: "numeric",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
        second: "numeric",
      });
    } catch {
      return null; // unknown IANA zone
    }
    formatterCache.set(timeZone, f);
  }
  return f;
}

type LocalParts = {
  year: number;
  month: number;
  day: number;
  weekday: number;
  minuteOfDay: number;
  second: number;
};

function localParts(date: Date, f: Intl.DateTimeFormat): LocalParts {
  const parts: Record<string, string> = {};
  for (const p of f.formatToParts(date)) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: WEEKDAY_INDEX[parts.weekday] ?? 0,
    minuteOfDay: Number(parts.hour) * 60 + Number(parts.minute),
    second: Number(parts.second),
  };
}

// The instant at which the zone's wall clock reads y-m-d HH:MM. Intl only goes
// instant → wall clock, so this guesses with the offset in force at the guess
// and corrects once; that is exact except inside a DST gap, where the result
// lands at the nearest valid instant, which is fine for a send window.
function instantForLocal(
  f: Intl.DateTimeFormat,
  year: number,
  month: number,
  day: number,
  minuteOfDay: number,
): Date {
  const wall = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60, 0);
  const offsetAt = (guess: Date) => {
    const p = localParts(guess, f);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, Math.floor(p.minuteOfDay / 60), p.minuteOfDay % 60, p.second);
    return asUtc - guess.getTime();
  };
  const first = new Date(wall - offsetAt(new Date(wall)));
  const second = new Date(wall - offsetAt(first));
  return second;
}

function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

// Pushes `date` forward to the next moment inside the send window (days 0..6,
// "HH:MM" from/to, read in `timeZone`). Returns `date` unchanged when it is
// already inside, when the window is malformed, or when the zone is unknown:
// the clamp only ever DELAYS, never advances, so it can't shorten a cycle below
// MIN_CYCLE_WAIT_MS and a bad window degrades to "no window" rather than to a
// silently dropped send. Pure, so the timeline preview can reuse it.
//
// A `to` earlier than `from` is a window that runs past midnight: "22:00 to
// 06:00 on Mon" opens Monday evening and closes Tuesday morning. The settings
// schema accepts that shape, so it has to mean something here rather than be
// silently dropped as malformed (only `from === to` is).
export function nextWindowOpen(date: Date, window: SendWindow, timeZone: string): Date {
  const f = formatterFor(timeZone) ?? formatterFor("UTC");
  if (!f) return date;
  const from = parseHHMM(window.from);
  const to = parseHHMM(window.to);
  if (from === null || to === null || from === to) return date;
  const days = new Set(window.days);
  if (days.size === 0) return date;
  const wraps = to < from;

  // Already inside: between from and to on an allowed day, or (wrapping) in the
  // small-hours tail of a window that opened on the previous day.
  const local = localParts(date, f);
  if (!wraps) {
    if (days.has(local.weekday) && local.minuteOfDay >= from && local.minuteOfDay < to) return date;
  } else {
    if (days.has(local.weekday) && local.minuteOfDay >= from) return date;
    if (days.has((local.weekday + 6) % 7) && local.minuteOfDay < to) return date;
  }

  // Not inside: the next opening is today's `from` if that is still ahead on an
  // allowed day, else `from` on the next allowed day. At most a week of days
  // plus one, since the window has at least one allowed day.
  let parts = local;
  for (let i = 0; i < 8; i++) {
    if (days.has(parts.weekday) && (i > 0 || parts.minuteOfDay < from)) {
      return instantForLocal(f, parts.year, parts.month, parts.day, from);
    }
    parts = localParts(instantForLocal(f, parts.year, parts.month, parts.day + 1, 0), f);
  }
  return date;
}

/* ─────────────────────────────── advance ─────────────────────────────── */

// The §5.4 algorithm for one enrollment. Claims the row (a not-due or
// non-active row is a no-op, which is what makes the immediate-enqueue + tick
// overlap and BullMQ retries safe), runs the exit checks, then executes nodes
// inline until it reaches a wait, a send, an end, or the step bound.
export async function advanceEnrollment(
  db: Db,
  deps: EngineDeps,
  enrollmentId: string,
): Promise<AdvanceOutcome> {
  const now = new Date();
  const nowStr = now.toISOString();

  const [claimed] = await db
    .update(automationEnrollments)
    .set({ updatedAt: nowStr })
    .where(
      and(
        eq(automationEnrollments.id, enrollmentId),
        eq(automationEnrollments.status, "active"),
        lte(automationEnrollments.nextRunAt, nowStr),
      ),
    )
    .returning();
  if (!claimed) return "not_due";
  let row: AutomationEnrollment = claimed;
  const log = logger.child({ enrollmentId: row.id, automationId: row.automationId, accountId: row.accountId });

  const automation = await loadAutomation(db, deps, row.accountId, row.automationId);
  if (!automation) {
    await failEnrollment(db, row, "automation no longer exists");
    return "failed";
  }
  if (automation.status === "archived") {
    return (await exitEnrollment(db, row, "automation_archived")) ? "exited" : "lost_race";
  }
  if (automation.status !== "active") {
    // Paused (or somehow un-published). Nothing moves, nothing is lost; the
    // enrollment is re-checked shortly and continues the moment it is resumed.
    return (await holdEnrollment(db, row, "automation_paused", PAUSED_RETRY_MS, now))
      ? "held"
      : "lost_race";
  }

  const graph = await loadGraph(db, deps, row.accountId, row.automationVersionId);

  // Exit checks, in order. The subscriber check is what guarantees an opt-out
  // drops someone before the next node, whatever node that is.
  const subscriber = await db.query.subscribers.findFirst({
    where: and(eq(subscribers.id, row.subscriberId), eq(subscribers.accountId, row.accountId)),
  });
  if (!subscriber || subscriber.status !== "subscribed") {
    const reason: AutomationExitReason =
      subscriber?.status === "unsubscribed" ? "unsubscribed" : "not_subscribed";
    return (await exitEnrollment(db, row, reason)) ? "exited" : "lost_race";
  }
  if (await isEmailSuppressed(db, row.accountId, subscriber.email)) {
    return (await exitEnrollment(db, row, "suppressed")) ? "exited" : "lost_race";
  }
  if (await exitFilterMatches(db, automation, subscriber)) {
    return (await exitEnrollment(db, row, "exit_filter")) ? "exited" : "lost_race";
  }

  let steps = 0;
  for (;;) {
    if (row.visitCount >= DEFAULT_VISIT_CAP || row.sendCount >= DEFAULT_SEND_CAP) {
      const exited = await exitEnrollment(db, row, "loop_guard");
      if (!exited) return "lost_race";
      await notifyLoopGuard(db, deps, automation, row).catch((err) =>
        log.error("loop-guard notification failed", { error: String(err) }),
      );
      return "exited";
    }

    const node = row.currentNodeKey ? findNode(graph, row.currentNodeKey) : null;
    if (!node) {
      await failEnrollment(db, row, `node ${row.currentNodeKey ?? "(none)"} is not on the pinned version`);
      return "failed";
    }

    let port: NodePort;
    switch (node.kind) {
      case "trigger":
      case "wait":
        // A claimed row sitting on a wait node means the wait elapsed: arrival
        // stamps the due time (see arrivalFor), so being due here is the wake.
        port = "next";
        break;
      case "branch":
        port = (await evaluateBranch(db, row, subscriber, node)) ? "yes" : "no";
        break;
      case "end": {
        const done = await applyArrival(db, row, { kind: "complete", endKey: node.key });
        return done ? "completed" : "lost_race";
      }
      case "send": {
        const outcome = await dispatchSend(db, deps, row, automation, graph, node, now);
        if (outcome.kind === "done") return outcome.outcome;
        // Too-stale skip: the node was skipped and the cursor moved on; keep
        // chaining from wherever it landed.
        row = outcome.row;
        steps++;
        if (isFuture(row.nextRunAt, now)) return "waiting";
        if (steps >= MAX_INLINE_STEPS) return deferRest(deps, row, log);
        continue;
      }
    }

    const arrival = arrivalFor(graph, automation, node.key, port, now);
    const next = await applyArrival(db, row, arrival);
    if (!next) return "lost_race";
    if (arrival.kind === "complete") return "completed";
    row = next;
    if (isFuture(arrival.nextRunAt, now)) return "waiting";
    steps++;
    if (steps >= MAX_INLINE_STEPS) return deferRest(deps, row, log);
  }
}

function isFuture(iso: string | null, now: Date): boolean {
  return !!iso && Date.parse(iso) > now.getTime();
}

// The step bound was hit with the cursor still due. next_run_at is already
// `now`, so the tick would resume it within a minute regardless; the enqueue
// just makes that immediate.
async function deferRest(
  deps: EngineDeps,
  row: AutomationEnrollment,
  log: ReturnType<typeof logger.child>,
): Promise<AdvanceOutcome> {
  try {
    await deps.queue.send({
      type: "advance_automation_enrollment",
      enrollmentId: row.id,
      accountId: row.accountId,
    });
  } catch (err) {
    log.warn("advance re-enqueue failed after step bound (tick will resume)", { error: String(err) });
  }
  return "deferred";
}

type SendDispatch =
  | { kind: "done"; outcome: AdvanceOutcome }
  | { kind: "continue"; row: AutomationEnrollment };

// A send node: check the §5.6 hold rule, then hand off to the send job. The
// engine never renders or sends; it only flips the enrollment to `sending` so
// the next tick keeps its hands off while the batch is in flight.
async function dispatchSend(
  db: Db,
  deps: EngineDeps,
  row: AutomationEnrollment,
  automation: Automation,
  graph: AutomationGraph,
  node: AutomationGraphNode,
  now: Date,
): Promise<SendDispatch> {
  const account = await loadAccount(db, deps, row.accountId);
  const holdReason = accountHoldReason(account, row.sandbox);
  if (holdReason) {
    if (holdIsStale(row, now)) {
      // Held past the cutoff: skip this node (recorded on the ledger so the
      // canvas can say why) and move on rather than send something a week late.
      await writeSkippedLedgerRow(db, row, automation, node, TOO_STALE_REASON);
      const moved = await applyArrival(db, row, arrivalFor(graph, automation, node.key, "next", now));
      if (!moved) return { kind: "done", outcome: "lost_race" };
      if (moved.status === "completed") return { kind: "done", outcome: "completed" };
      return { kind: "continue", row: moved };
    }
    const held = await holdEnrollment(db, row, holdReason, HOLD_RETRY_MS, now);
    return { kind: "done", outcome: held ? "held" : "lost_race" };
  }

  // holdReason / heldSince are deliberately NOT cleared here. Quota is only
  // known to the send handler, so a quota-held enrollment cycles engine ->
  // sending -> hold every hour; clearing heldSince on the way through would
  // restart the staleness clock on every lap and the 7-day cutoff could never
  // arrive, which is the unbounded hold §5.6 exists to prevent. applyArrival
  // clears both once the node actually resolves.
  const sending = await casEnrollment(db, row, {
    status: "sending",
    lockedAt: now.toISOString(),
  });
  if (!sending) return { kind: "done", outcome: "lost_race" };
  try {
    await deps.queue.send({
      type: "send_automation_node",
      enrollmentId: row.id,
      accountId: row.accountId,
    });
  } catch (err) {
    // Nothing was sent, so hand the row straight back: the tick re-dispatches it
    // rather than the stuck-lock sweep failing it 15 minutes from now.
    await casEnrollment(db, sending, { status: "active", lockedAt: null });
    throw err;
  }
  return { kind: "done", outcome: "sending" };
}

// Why an account cannot send right now, or null when it can. Sandbox
// enrollments belong to free orgs whose sendingEnabled is false by design, so
// they check risk and subscription only (the rule send-batch applies).
export function accountHoldReason(account: Account | undefined, sandbox: boolean): string | null {
  if (!account) return "account_missing";
  if (account.subscriptionStatus !== "active") return "subscription_inactive";
  if (account.riskStatus === "paused") return "risk_paused";
  if (!sandbox && !account.sendingEnabled) return "sending_disabled";
  return null;
}

// The visit_no a send node's ledger row keys on: the current lap when the node
// allows re-sends, else 0 so the unique index reads "once per node per person".
export function visitNoFor(node: AutomationGraphNode, row: AutomationEnrollment): number {
  const config = node.config as { allowResend?: boolean } | null | undefined;
  return config?.allowResend ? row.visitCount : 0;
}

// A ledger row that records a send that did NOT happen, with the reason, so
// "why didn't this send?" has an answer on the canvas. Dedupe-safe on the
// (enrollment, node, visit) key; an existing pending row is resolved in place.
export async function writeSkippedLedgerRow(
  db: Db,
  row: AutomationEnrollment,
  automation: Automation,
  node: AutomationGraphNode,
  reason: string,
  email?: string,
): Promise<void> {
  const now = nowIso();
  const visitNo = visitNoFor(node, row);
  let address = email;
  if (!address) {
    const sub = await db.query.subscribers.findFirst({
      columns: { email: true },
      where: and(eq(subscribers.id, row.subscriberId), eq(subscribers.accountId, row.accountId)),
    });
    address = sub?.email ?? "";
  }
  const inserted = await db
    .insert(campaignRecipients)
    .values({
      id: newId("rcp"),
      campaignId: null,
      accountId: row.accountId,
      subscriberId: row.subscriberId,
      email: address,
      automationId: automation.id,
      automationEnrollmentId: row.id,
      automationNodeKey: node.key,
      visitNo,
      status: "skipped",
      error: reason,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: campaignRecipients.id });
  if (inserted.length === 0) {
    await db
      .update(campaignRecipients)
      .set({ status: "skipped", error: reason, lockedAt: null, updatedAt: now })
      .where(
        and(
          eq(campaignRecipients.automationEnrollmentId, row.id),
          eq(campaignRecipients.automationNodeKey, node.key),
          eq(campaignRecipients.visitNo, visitNo),
          eq(campaignRecipients.status, "pending"),
        ),
      );
  }
}

/* ────────────────────────────── predicates ────────────────────────────── */

async function exitFilterMatches(db: Db, automation: Automation, subscriber: Subscriber): Promise<boolean> {
  if (!automation.exitFilterJson) return false;
  const filter = safeParseSegmentFilter(automation.exitFilterJson);
  // A corrupt exit filter is ignored rather than failed closed: exiting
  // everyone is the destructive reading, continuing is the recoverable one.
  if (!filter) {
    logger.warn("automation exit filter failed to parse; ignoring", { automationId: automation.id });
    return false;
  }
  return subscriberMatchesFilter(db, subscriber, filter);
}

export async function subscriberMatchesFilter(
  db: Db,
  subscriber: Pick<Subscriber, "id" | "accountId">,
  filter: NonNullable<ReturnType<typeof safeParseSegmentFilter>>,
): Promise<boolean> {
  const [hit] = await db
    .select({ id: subscribers.id })
    .from(subscribers)
    .where(
      and(
        eq(subscribers.id, subscriber.id),
        eq(subscribers.accountId, subscriber.accountId),
        segmentFilterCondition(filter),
      ),
    )
    .limit(1);
  return !!hit;
}

async function evaluateBranch(
  db: Db,
  row: AutomationEnrollment,
  subscriber: Subscriber,
  node: AutomationGraphNode,
): Promise<boolean> {
  const parsed = BranchNodeConfigSchema.safeParse(node.config ?? {});
  if (!parsed.success) return false; // an unconfigured branch routes "no"
  const condition = parsed.data.condition;
  if (condition.kind === "filter") {
    return subscriberMatchesFilter(db, subscriber, condition.filter);
  }
  // Engagement predicates read this enrollment's own sends off the shared
  // ledger. A click back-fills opened_at (see recordClick), so "opened"
  // includes anyone who clicked without loading the pixel.
  const rows = await db
    .select({ openedAt: campaignRecipients.openedAt, clickedAt: campaignRecipients.clickedAt })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.accountId, row.accountId),
        eq(campaignRecipients.automationEnrollmentId, row.id),
        condition.nodeKey ? eq(campaignRecipients.automationNodeKey, condition.nodeKey) : undefined,
      ),
    );
  const opened = rows.some((r) => !!r.openedAt);
  const clicked = rows.some((r) => !!r.clickedAt);
  switch (condition.event) {
    case "opened":
      return opened;
    case "not_opened":
      return !opened;
    case "clicked":
      return clicked;
    case "not_clicked":
      return !clicked;
  }
}

/* ───────────────────────────── notifications ──────────────────────────── */

// Once per automation per day, whatever the enrollment count: a looping flow
// exits everyone in it, and one message says what a thousand would.
async function notifyLoopGuard(
  db: Db,
  deps: EngineDeps,
  automation: Automation,
  row: AutomationEnrollment,
): Promise<void> {
  const ctaHref = `/automations/${automation.id}`;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [recent] = await db
    .select({ id: notifications.id })
    .from(notifications)
    .where(
      and(
        eq(notifications.accountId, row.accountId),
        eq(notifications.kind, LOOP_GUARD_NOTIFICATION_KIND),
        eq(notifications.ctaHref, ctaHref),
        gt(notifications.createdAt, since),
      ),
    )
    .limit(1);
  if (recent) return;
  const account = await loadAccount(db, deps, row.accountId);
  if (!account) return;
  await notifyAccount(db, account, {
    kind: LOOP_GUARD_NOTIFICATION_KIND,
    title: `"${automation.name}" hit its safety limit for a subscriber`,
    body:
      `A person in "${automation.name}" went through ${DEFAULT_VISIT_CAP} steps or was sent ${DEFAULT_SEND_CAP} emails, ` +
      "so we stopped the flow for them. This usually means the flow loops back on itself without a way out. " +
      "Check the canvas for a loop that never ends.",
    ctaHref,
    ctaLabel: "Open the automation",
  });
}
