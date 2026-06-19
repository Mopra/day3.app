// Worker liveness signal shared by the writer (the VPS BullMQ worker) and the
// reader (the /api/health endpoint on the web tier). The worker writes a Redis
// key with the current timestamp on an interval; the health endpoint reads it
// and flags the worker as stale if it hasn't beaten recently. This is how a dead
// worker (campaigns silently stop sending) is detected before customers notice.
import type { Redis } from "ioredis";

export const HEARTBEAT_KEY = "day3:worker:heartbeat";

// How often the worker writes its heartbeat.
export const HEARTBEAT_INTERVAL_MS = 30_000;

// The key carries a TTL so a crashed worker's heartbeat disappears on its own;
// the staleness check below is the primary signal, the TTL is a backstop.
const HEARTBEAT_TTL_SECONDS = 120;

// The worker is considered stale (likely dead) if its last heartbeat is older
// than this. Generous relative to the interval so a single missed beat or a GC
// pause doesn't flap the health check.
export const HEARTBEAT_STALE_MS = 90_000;

export type HeartbeatState =
  | { present: false }
  | { present: true; at: string; ageMs: number; stale: boolean };

// Write the heartbeat. Best-effort: a Redis blip must never crash the worker.
export async function writeHeartbeat(
  redis: Pick<Redis, "set">,
  now: Date = new Date(),
): Promise<void> {
  await redis.set(HEARTBEAT_KEY, now.toISOString(), "EX", HEARTBEAT_TTL_SECONDS);
}

// Read + interpret the heartbeat for the health endpoint.
export async function readHeartbeat(
  redis: Pick<Redis, "get">,
  now: Date = new Date(),
): Promise<HeartbeatState> {
  const raw = await redis.get(HEARTBEAT_KEY);
  if (!raw) return { present: false };
  const ts = Date.parse(raw);
  if (Number.isNaN(ts)) return { present: false };
  const ageMs = now.getTime() - ts;
  return { present: true, at: raw, ageMs, stale: ageMs > HEARTBEAT_STALE_MS };
}
