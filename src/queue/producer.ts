import { Queue, type ConnectionOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { logger } from "../lib/logger";
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAME,
  jobOptionsFor,
  type JobQueue,
  type QueueMessage,
} from "./messages";

// Producer side of the queue (runs on Vercel). API route handlers enqueue jobs
// here; the VPS worker (worker/index.ts) consumes them. The connection is lazy
// and cached so a serverless instance reuses one Redis socket across warm
// invocations.
let connection: Redis | undefined;
let queue: Queue | undefined;

export function getRedisConnection(): Redis {
  if (!connection) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error("REDIS_URL is not set");
    // rediss:// in the URL turns on TLS automatically. maxRetriesPerRequest:null
    // is required by BullMQ and harmless for the producer.
    //
    // Fail fast, don't hang: routes flip DB state around their enqueue, so an
    // enqueue during a Redis outage must reject promptly (surfacing a real 5xx
    // the sweep can later reconcile) — with the default offline queue the
    // command would sit unsent until the serverless function is killed, which
    // looks identical to success right up until it isn't.
    connection = new IORedis(url, {
      maxRetriesPerRequest: null,
      enableOfflineQueue: false,
      commandTimeout: 5000,
      // Cap the reconnect backoff. ioredis' default (min(times * 50, 2000)) means
      // a serverless instance whose socket died while it was frozen wakes into a
      // reconnect attempt every 2s for the rest of its life. Widen the ceiling so
      // an unreachable Redis costs a handful of attempts per minute, not ~30.
      retryStrategy: (times) => Math.min(times * 200, 15_000),
    });
    // ioredis emits 'error' on every failed connect/reconnect. Without a listener
    // it falls back to logging "[ioredis] Unhandled error event" for each one,
    // which on the paths that use this connection bare — the health probe, the
    // rate limiter, the AI budget — turns a Redis blip into an unbounded stream of
    // log noise (BullMQ attaches its own listener, but only to connections the
    // Queue wraps). Report it once per event through the redacted sink instead.
    connection.on("error", (err) => {
      void logger.reportError("redis connection error (producer)", err);
    });
  }
  return connection;
}

function getBullQueue(): Queue {
  if (!queue) {
    // Cast bridges the duplicate-ioredis types (bullmq bundles its own copy);
    // the instance is runtime-compatible.
    queue = new Queue(QUEUE_NAME, {
      connection: getRedisConnection() as unknown as ConnectionOptions,
      defaultJobOptions: DEFAULT_JOB_OPTIONS,
    });
  }
  return queue;
}

// Drop the cached socket so the next caller dials a fresh one. A serverless
// instance frozen overnight thaws holding a half-open Redis socket: ioredis still
// reports it "ready", every command written to it times out, and nothing ever
// closes it, so without this the instance could not enqueue for the rest of its
// life. This is the likeliest reason two campaigns sat in pending_review on
// 2026-10-12: the morning's first submits flipped the status, and the worker log
// shows their review job never reached Redis.
function resetConnection(): void {
  const q = queue;
  const c = connection;
  queue = undefined;
  connection = undefined;
  void q?.close().catch(() => {});
  c?.disconnect();
}

// The JobQueue the route handlers enqueue through (same interface the test
// FakeQueue implements). Job name = message.type; the worker routes on it.
// Handlers are idempotent on DB status, so no enqueue-level dedup is needed,
// and that is also what makes the one retry below safe: if the first add did
// reach Redis and only its reply was lost, the duplicate job is a no-op.
export function getQueue(): JobQueue {
  return {
    async send(message: QueueMessage, opts?: { delayMs?: number }) {
      const jobOpts = jobOptionsFor(message.type, opts);
      try {
        await getBullQueue().add(message.type, message, jobOpts);
      } catch (err) {
        logger.warn("enqueue failed; retrying on a fresh redis connection", {
          jobType: message.type,
          error: err instanceof Error ? err.message : String(err),
        });
        resetConnection();
        await getBullQueue().add(message.type, message, jobOpts);
      }
    },
  };
}
