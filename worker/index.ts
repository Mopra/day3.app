// Day3 background worker (runs on the VPS). Consumes the BullMQ queue and runs
// the cron sweeps. Start with `npm run worker` (tsx) under pm2/systemd/Docker.
// Replaces the Cloudflare Worker `queue` consumer + `scheduled` cron handler.
import "./load-env";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAME,
  envInt,
  type JobQueue,
  type QueueMessage,
} from "../src/queue/messages";
import { handleQueueMessage, type QueueDeps } from "../src/queue/consumer";
import { runScheduledSweeps } from "../src/queue/cron";
import { recordDeadLetter } from "../src/lib/job-log";
import { logger } from "../src/lib/logger";
import { getDb } from "../src/db/client";
import { emailProviderFromEnv } from "../src/email/factory";
import { createSupabaseObjectStore } from "../src/lib/supabase-storage";
import { requireAppUrl, requireUnsubscribeSecret, validateEnv } from "../src/lib/env";
import { writeHeartbeat, HEARTBEAT_INTERVAL_MS } from "../src/lib/heartbeat";

// Fail fast before the worker begins consuming: a missing/weak secret here would
// otherwise sign unsubscribe links with an empty HMAC key.
validateEnv("worker");

const SWEEP_JOB = "scheduled_sweep";
const SWEEP_SCHEDULER = "cron-15min";
// Concurrent jobs this worker processes. For a single campaign, effective send
// parallelism is min(SEND_LANES, WORKER_CONCURRENCY × replicas), so keep this at
// or above SEND_LANES (default 8) to saturate the lanes. Size DB_POOL_MAX to
// match (see src/db/client.ts). NaN-safe parse: an env typo must fall back to
// the default, not spin up a NaN-concurrency worker.
const CONCURRENCY = envInt("WORKER_CONCURRENCY", 8, 1, 64);

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

// Flipped by shutdown() before worker.close(). Long-running handlers (the send
// batch loop) poll it between recipients and return their unsent remainder to
// pending, so a routine deploy never leaves claimed rows behind to be swept to
// "failed" 15 minutes later.
let draining = false;

const deps: QueueDeps = {
  db: getDb(),
  queue: jobQueue,
  emailProvider: emailProviderFromEnv(),
  store: createSupabaseObjectStore(),
  appUrl: requireAppUrl(),
  unsubscribeSecret: requireUnsubscribeSecret(),
  aiReviewMode: process.env.AI_REVIEW_MODE,
  shouldAbort: () => draining,
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
    // Default is 1: a job whose worker was killed twice in a row (deploy
    // crash-loop) would be terminally failed as "stalled" without consuming its
    // retry budget. Redelivery is claim-safe (handlers are idempotent on DB
    // status), so tolerate a couple of stalls before giving up.
    maxStalledCount: 3,
  },
);

worker.on("ready", () =>
  logger.info("worker ready", { queue: QUEUE_NAME, concurrency: CONCURRENCY }),
);
worker.on("failed", (job, err) => {
  logger.child({ jobName: job?.name, jobId: job?.id }).warn("job attempt failed", {
    attemptsMade: job?.attemptsMade,
    error: err?.message ?? String(err),
  });
  // BullMQ fires "failed" on every attempt. Only terminal failures are
  // dead-lettered (mirrored to job_logs) so transient retries don't spam the
  // table: either retries are exhausted (`attemptsMade` reaches the `attempts`
  // cap), or BullMQ gave up on a repeatedly-stalled job — stall failures do NOT
  // consume the retry budget, so without the explicit check they would vanish
  // with only a warn log. The sweep job never dead-letters (it has no
  // DB-observable entity).
  const exhausted =
    !!job && job.attemptsMade >= (job.opts.attempts ?? DEFAULT_JOB_OPTIONS.attempts);
  const stalledOut = /stalled more than/i.test(err?.message ?? "");
  if (job && job.name !== SWEEP_JOB && (exhausted || stalledOut)) {
    const dlLog = logger.child({ jobName: job.name, jobId: job.id });
    void dlLog
      .reportError("job dead-lettered (retries exhausted)", err, {
        attemptsMade: job.attemptsMade,
      })
      .catch((logErr) => dlLog.error("error-report for dead-letter failed", { error: String(logErr) }));
    void recordDeadLetter(deps.db, {
      jobType: job.name,
      jobId: job.id,
      attemptsMade: job.attemptsMade,
      error: err?.message ?? String(err),
      payload: job.data,
    }).catch((logErr) => dlLog.error("dead-letter record failed", { error: String(logErr) }));
  }
});
worker.on("error", (err) => void logger.reportError("worker error", err));

// Repeatable cron sweep every 15 minutes (replaces the CF `scheduled` trigger):
// stuck-lock recovery, sending-campaign reconcile, daily health, monthly reset.
await queue.upsertJobScheduler(
  SWEEP_SCHEDULER,
  { pattern: "0 */15 * * * *" },
  { name: SWEEP_JOB, data: {} },
);
logger.info("cron sweep scheduled", { scheduler: SWEEP_SCHEDULER, pattern: "every 15 min" });

// Worker liveness signal: write a Redis heartbeat now and on an interval. The
// /api/health endpoint on the web tier reads this key to detect a dead worker
// (campaigns would silently stop sending) within ~90s, far faster than the
// 15-min cron staleness signal. Best-effort — a Redis blip must never crash the
// worker, and the interval is unref'd so it can't keep the process alive on its
// own during shutdown.
//
// The beat must attest to the CONSUMING side, not just this timer being alive:
// the classic failure is workerConnection's blocking socket half-opening (NAT
// idle timeout, Redis failover) so no jobs are fetched while the separate
// producer connection stays healthy — a heartbeat written unconditionally on
// queueConnection would report a wedged worker as alive indefinitely. So the
// beat is skipped unless the Worker is running AND a PING on the worker's own
// connection answers promptly; skipped beats let the key go stale and the
// health endpoint fires.
async function workerAlive(): Promise<boolean> {
  if (!worker.isRunning()) return false;
  try {
    const timeout = new Promise<false>((resolve) => {
      const t = setTimeout(() => resolve(false), 2000);
      t.unref();
    });
    return await Promise.race([workerConnection.ping().then(() => true), timeout]);
  } catch {
    return false;
  }
}
async function beat(): Promise<void> {
  try {
    if (!(await workerAlive())) {
      logger.warn("heartbeat skipped: worker connection not responding");
      return;
    }
    await writeHeartbeat(queueConnection);
  } catch (err) {
    logger.warn("heartbeat write failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
await beat();
const heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref();

async function shutdown(signal: string): Promise<void> {
  logger.info("worker shutting down", { signal });
  // Signal in-flight send batches to stop between recipients and return their
  // unsent remainder to pending BEFORE closing the worker: worker.close() waits
  // for active jobs, and supervisors (pm2/systemd/Docker) SIGKILL long before a
  // full batch of serial sends would finish on its own.
  draining = true;
  clearInterval(heartbeatTimer);
  let clean = true;
  try {
    await worker.close();
    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
  } catch (err) {
    clean = false;
    logger.error("worker shutdown did not drain cleanly", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    process.exit(clean ? 0 : 1);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
