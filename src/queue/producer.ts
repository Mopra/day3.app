import { Queue, type ConnectionOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { logger } from "../lib/logger";
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAME,
  jobPriorityFor,
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

// The JobQueue the route handlers enqueue through (same interface the test
// FakeQueue implements). Job name = message.type; the worker routes on it.
// Handlers are idempotent on DB status, so no enqueue-level dedup is needed.
export function getQueue(): JobQueue {
  const q = getBullQueue();
  return {
    async send(message: QueueMessage, opts?: { delayMs?: number }) {
      await q.add(message.type, message, {
        priority: jobPriorityFor(message.type),
        ...(opts?.delayMs ? { delay: opts.delayMs } : {}),
      });
    },
  };
}
