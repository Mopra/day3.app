import { route } from "@/api/http";
import { getDb, resetDb } from "@/db/client";
import { checkHealth, healthHttpStatus, type HealthReport } from "@/lib/health";
import { readHeartbeat } from "@/lib/heartbeat";
import { withDeadline } from "@/lib/deadline";
import { buildInfo } from "@/lib/version";
import { logger } from "@/lib/logger";
import { getRedisConnection } from "@/queue/producer";
import type { HeartbeatState } from "@/lib/heartbeat";

// Health / readiness probe. Public and unauthenticated by design — Vercel, the
// VPS process manager, and an uptime monitor all need to hit it without creds.
// Returns 200 when the DB is reachable (with a body describing DB, cron-sweep
// freshness, and worker-heartbeat sub-checks) and 503 when the DB is down, so a
// load balancer / monitor can take the instance out of rotation.
//
// Never cached: each call must reflect live state.
export const dynamic = "force-dynamic";

// This endpoint must ALWAYS answer, and quickly. A monitor that receives no
// response byte records a TTFB timeout, which is indistinguishable from the whole
// app being down — so a slow dependency here manufactures fake outages. Every
// dependency is individually bounded (see src/lib/health.ts), and this is the
// backstop for anything that slips past them.
const OVERALL_TIMEOUT_MS = 9000;

// Read the worker heartbeat from Redis, best-effort. If REDIS_URL is unset or
// Redis is unreachable from the web tier, we return null and the health module
// reports the worker as "unknown but ok" (the cron staleness check still catches
// a dead worker against the DB, which never requires Redis).
//
// ioredis enforces its own `commandTimeout` client-side, so this is already
// bounded — the deadline is belt-and-braces for the connect path.
async function readWorkerHeartbeat(): Promise<HeartbeatState | null> {
  try {
    return await withDeadline(readHeartbeat(getRedisConnection()), 2000, "health heartbeat");
  } catch {
    return null;
  }
}

// Last-resort body for when even the bounded checks didn't settle in time. Shaped
// like a normal report so a body-asserting monitor still parses it, and reported
// as unhealthy (503) because an instance that can't answer its own probe should
// be taken out of rotation.
function timedOutReport(): HealthReport {
  return {
    status: "unhealthy",
    build: buildInfo(),
    checks: {
      db: { ok: false, detail: "health check timed out" },
      cron: { ok: false, detail: "skipped (health check timed out)" },
      worker: { ok: false, detail: "skipped (health check timed out)" },
    },
    timestamp: new Date().toISOString(),
  };
}

export const GET = route(async () => {
  let report: HealthReport;
  try {
    const heartbeat = await readWorkerHeartbeat();
    report = await withDeadline(
      checkHealth({ db: getDb(), heartbeat, onDbWedged: resetDb }),
      OVERALL_TIMEOUT_MS,
      "health check",
    );
  } catch (err) {
    // Nothing here may throw: a 500 from the probe is still a probe that answered,
    // but an unhandled rejection would surface as an empty response.
    void logger.reportError("health: check did not settle", err);
    // Assume the pool is at fault and discard it, so the next probe starts clean.
    resetDb();
    report = timedOutReport();
  }
  return Response.json(report, { status: healthHttpStatus(report) });
});
