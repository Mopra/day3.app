// Day3 background worker (runs on the VPS). Consumes the BullMQ queue and runs
// the cron sweeps. Start with `npm run worker` (tsx) under pm2/systemd/Docker.
// Replaces the Cloudflare Worker `queue` consumer + `scheduled` cron handler.
import "./load-env";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAME,
  type JobQueue,
  type QueueMessage,
} from "../src/queue/messages";
import { handleQueueMessage, type QueueDeps } from "../src/queue/consumer";
import { runScheduledSweeps } from "../src/queue/cron";
import { getDb } from "../src/db/client";
import { emailProviderFromEnv } from "../src/email/factory";
import { createSupabaseObjectStore } from "../src/lib/supabase-storage";

const SWEEP_JOB = "scheduled_sweep";
const SWEEP_SCHEDULER = "cron-15min";
const CONCURRENCY = Number(process.env.WORKER_CONCURRENCY ?? "5");

function makeConnection(): IORedis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  // rediss:// enables TLS automatically. maxRetriesPerRequest:null is required
  // for BullMQ's blocking Worker connection.
  return new IORedis(url, { maxRetriesPerRequest: null });
}

// Separate connections for the producer/scheduler vs the blocking Worker (the
// `as unknown as ConnectionOptions` bridges bullmq's bundled-ioredis types).
const queueConnection = makeConnection();
const queue = new Queue(QUEUE_NAME, {
  connection: queueConnection as unknown as ConnectionOptions,
  defaultJobOptions: DEFAULT_JOB_OPTIONS,
});

// The handlers enqueue follow-up jobs (next batch, recipient generation, …)
// through this same queue.
const jobQueue: JobQueue = {
  async send(message: QueueMessage) {
    await queue.add(message.type, message);
  },
};

const deps: QueueDeps = {
  db: getDb(),
  queue: jobQueue,
  emailProvider: emailProviderFromEnv(),
  store: createSupabaseObjectStore(),
  appUrl: process.env.APP_URL ?? "",
  unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET ?? "",
  aiReviewMode: process.env.AI_REVIEW_MODE,
};

const workerConnection = makeConnection();
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    if (job.name === SWEEP_JOB) {
      await runScheduledSweeps({ db: deps.db, queue: deps.queue });
      return;
    }
    // A thrown error fails the job; BullMQ retries per DEFAULT_JOB_OPTIONS. The
    // handlers are idempotent on DB status, so retries never double-send.
    await handleQueueMessage(job.data as QueueMessage, deps);
  },
  {
    connection: workerConnection as unknown as ConnectionOptions,
    concurrency: CONCURRENCY,
  },
);

worker.on("ready", () =>
  console.log(`[worker] ready — queue=${QUEUE_NAME} concurrency=${CONCURRENCY}`),
);
worker.on("failed", (job, err) =>
  console.error(`[worker] job ${job?.name ?? "?"} (${job?.id ?? "?"}) failed:`, err?.message ?? err),
);
worker.on("error", (err) => console.error("[worker] error:", err));

// Repeatable cron sweep every 15 minutes (replaces the CF `scheduled` trigger):
// stuck-lock recovery, sending-campaign reconcile, daily health, monthly reset.
await queue.upsertJobScheduler(
  SWEEP_SCHEDULER,
  { pattern: "0 */15 * * * *" },
  { name: SWEEP_JOB, data: {} },
);
console.log(`[worker] cron sweep scheduled (${SWEEP_SCHEDULER}: every 15 min)`);

async function shutdown(signal: string): Promise<void> {
  console.log(`[worker] ${signal} — closing...`);
  try {
    await worker.close();
    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
  } finally {
    process.exit(0);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
