import { Queue, type ConnectionOptions } from "bullmq";
import IORedis, { type Redis } from "ioredis";
import { DEFAULT_JOB_OPTIONS, QUEUE_NAME, type JobQueue, type QueueMessage } from "./messages";

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
    connection = new IORedis(url, { maxRetriesPerRequest: null });
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
    async send(message: QueueMessage) {
      await q.add(message.type, message);
    },
  };
}
