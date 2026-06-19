import { desc, eq, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { jobLogs } from "../db/schema";
import { buildInfo, type BuildInfo } from "./version";
import type { HeartbeatState } from "./heartbeat";
import { logger } from "./logger";

// Readiness/health snapshot for the web tier. Three things matter for "is this
// service actually working":
//   1. DB reachable (every request needs it; if down the tier is useless).
//   2. The cron sweep is running (its last-run is recorded in job_logs; a stale
//      last-run means the worker's repeatable job stopped — campaigns would
//      silently stall on stuck-lock recovery / health enforcement).
//   3. The worker is alive (its Redis heartbeat; the cron staleness covers the
//      same failure but at 15-min granularity, the heartbeat catches it in ~90s).
//
// `db` failure is the only condition that makes the endpoint return 503 — that's
// what an uptime monitor / load balancer should treat as "take this instance out
// of rotation". A stale worker is reported as a degraded sub-check (HTTP 200,
// status "degraded") so the page stays green for the *web* tier but a monitor
// watching the body can alert on the worker independently.
//
// SECURITY: this endpoint is public and unauthenticated, so the response body
// must never carry raw driver/error text — postgres-js connection errors leak
// host/IP/port (e.g. `connect ECONNREFUSED <host>:6543`) and auth errors leak
// the database/username. Sub-check `detail` strings are therefore always generic
// and constant; the real error is shipped to the log / error sink via
// `logger.reportError` instead, where redaction already applies.

// The cron sweep runs every 15 minutes; flag it stale well past two missed runs.
export const CRON_STALE_MS = 40 * 60 * 1000;

export type CheckResult = { ok: boolean; detail?: string };

export type HealthReport = {
  status: "ok" | "degraded" | "unhealthy";
  build: BuildInfo;
  checks: {
    db: CheckResult;
    cron: CheckResult & { lastRunAt?: string; ageMs?: number };
    worker: CheckResult & { lastBeatAt?: string; ageMs?: number };
  };
  timestamp: string;
};

// Generic, constant detail strings returned to the (public) client. The real
// driver error is sent to the log / error sink, never the response body.
const DB_UNREACHABLE_DETAIL = "database unreachable";
const CRON_CHECK_FAILED_DETAIL = "cron check failed";

async function checkDb(db: Db): Promise<CheckResult> {
  try {
    // Cheapest possible round-trip that proves the connection + auth work.
    await db.execute(sql`select 1`);
    return { ok: true };
  } catch (err) {
    // Real error (host/IP/port/credentials) goes to the redacted log/error sink
    // only — the public body gets a generic detail.
    void logger.reportError("health: db check failed", err);
    return { ok: false, detail: DB_UNREACHABLE_DETAIL };
  }
}

async function checkCron(
  db: Db,
  now: Date,
): Promise<CheckResult & { lastRunAt?: string; ageMs?: number }> {
  let lastRun: { createdAt: string } | undefined;
  try {
    lastRun = await db.query.jobLogs.findFirst({
      where: eq(jobLogs.jobType, "cron"),
      orderBy: desc(jobLogs.createdAt),
      columns: { createdAt: true },
    });
  } catch (err) {
    // Same as checkDb: keep the driver error out of the public body, send it to
    // the redacted log/error sink instead.
    void logger.reportError("health: cron check failed", err);
    return { ok: false, detail: CRON_CHECK_FAILED_DETAIL };
  }
  if (!lastRun) {
    return { ok: false, detail: "no cron sweep has run yet" };
  }
  const ageMs = now.getTime() - Date.parse(lastRun.createdAt);
  const stale = ageMs > CRON_STALE_MS;
  return {
    ok: !stale,
    detail: stale ? "cron sweep is stale" : undefined,
    lastRunAt: lastRun.createdAt,
    ageMs,
  };
}

function checkWorker(
  heartbeat: HeartbeatState | null,
): CheckResult & { lastBeatAt?: string; ageMs?: number } {
  // Heartbeat unavailable (Redis not reachable from this tier, or the read
  // failed): don't fail the endpoint on it — the cron check still covers a dead
  // worker. Report it as unknown-but-ok so the page stays green.
  if (!heartbeat) return { ok: true, detail: "heartbeat unavailable" };
  if (!heartbeat.present) return { ok: false, detail: "no worker heartbeat" };
  return {
    ok: !heartbeat.stale,
    detail: heartbeat.stale ? "worker heartbeat is stale" : undefined,
    lastBeatAt: heartbeat.at,
    ageMs: heartbeat.ageMs,
  };
}

export type HealthDeps = {
  db: Db;
  // Worker heartbeat, already read from Redis (or null when unavailable). Passed
  // in so the health module has no Redis dependency and stays unit-testable.
  heartbeat?: HeartbeatState | null;
  now?: Date;
  env?: NodeJS.ProcessEnv;
};

export async function checkHealth(deps: HealthDeps): Promise<HealthReport> {
  const now = deps.now ?? new Date();
  const db = await checkDb(deps.db);

  // If the DB is down there's nothing meaningful to report for the DB-backed
  // cron check; mark it unknown rather than running a query that will also fail.
  const cron = db.ok
    ? await checkCron(deps.db, now)
    : { ok: false, detail: "skipped (db down)" };
  const worker = checkWorker(deps.heartbeat ?? null);

  // DB down → unhealthy (503). Otherwise any failing sub-check → degraded (200).
  const status: HealthReport["status"] = !db.ok
    ? "unhealthy"
    : cron.ok && worker.ok
      ? "ok"
      : "degraded";

  return {
    status,
    build: buildInfo(deps.env),
    checks: { db, cron, worker },
    timestamp: now.toISOString(),
  };
}

// Maps a report to the HTTP status the endpoint returns: 503 only when the DB is
// unreachable (the "remove from rotation" signal), 200 otherwise.
export function healthHttpStatus(report: HealthReport): number {
  return report.status === "unhealthy" ? 503 : 200;
}
