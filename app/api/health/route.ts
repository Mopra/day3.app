import { route } from "@/api/http";
import { getDb } from "@/db/client";
import { checkHealth, healthHttpStatus } from "@/lib/health";
import { readHeartbeat } from "@/lib/heartbeat";
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

// Read the worker heartbeat from Redis, best-effort. If REDIS_URL is unset or
// Redis is unreachable from the web tier, we return null and the health module
// reports the worker as "unknown but ok" (the cron staleness check still catches
// a dead worker against the DB, which never requires Redis).
async function readWorkerHeartbeat(): Promise<HeartbeatState | null> {
  try {
    return await readHeartbeat(getRedisConnection());
  } catch {
    return null;
  }
}

export const GET = route(async () => {
  const heartbeat = await readWorkerHeartbeat();
  const report = await checkHealth({ db: getDb(), heartbeat });
  return Response.json(report, { status: healthHttpStatus(report) });
});
