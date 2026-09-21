// Day3 background worker (runs on the VPS). Consumes the BullMQ queue and runs
// the cron sweeps. Start with `npm run worker` (tsx) under pm2/systemd/Docker.
// Replaces the Cloudflare Worker `queue` consumer + `scheduled` cron handler.
//
// Failure-mode contract (docs/delivery-resilience.md has the full matrix):
//   - killed mid-job (crash, SIGKILL, power loss): every handler is idempotent
//     on Postgres status, BullMQ redelivers the job, and the 15-min cron sweep
//     resolves anything a dead process left claimed. Nothing here is the source
//     of truth.
//   - SIGTERM (deploy, restart): drain — in-flight batches stop between
//     recipients and hand their remainder back, bounded by SHUTDOWN_DEADLINE_MS
//     so a wedged job cannot hold the restart hostage.
//   - Redis unreachable: ioredis reconnects; BullMQ redelivers jobs whose lock
//     lapsed; the repeatable schedulers are re-registered on reconnect in case
//     the data behind them is gone (see ensureSchedulers).
//   - Postgres unreachable: jobs throw and retry with backoff; the sweep picks up
//     what dead-letters. The pool's TCP keepalive surfaces a dead peer.
import "./load-env";
import { Queue, Worker, type ConnectionOptions } from "bullmq";
import IORedis from "ioredis";
import {
  DEFAULT_JOB_OPTIONS,
  QUEUE_NAME,
  SEND_LANES,
  envInt,
  jobOptionsFor,
  type JobQueue,
  type QueueMessage,
} from "../src/queue/messages";
import { handleQueueMessage, type QueueDeps } from "../src/queue/consumer";
import { setAmbientQueue } from "../src/queue/enqueue";
import { runScheduledSweeps } from "../src/queue/cron";
import { recordDeadLetter } from "../src/lib/job-log";
import { logger } from "../src/lib/logger";
import { getDb } from "../src/db/client";
import { emailProviderFromEnv } from "../src/email/factory";
import { createSendPacer, withSendPacing } from "../src/email/send-rate";
import { createSendBudget, withSendBudget } from "../src/email/send-budget";
import { createSupabaseObjectStore } from "../src/lib/supabase-storage";
import { requireAppUrl, requireUnsubscribeSecret, validateEnv } from "../src/lib/env";
import { writeHeartbeat, HEARTBEAT_INTERVAL_MS } from "../src/lib/heartbeat";

// Fail fast before the worker begins consuming: a missing/weak secret here would
// otherwise sign unsubscribe links with an empty HMAC key.
validateEnv("worker");

// An exception nobody caught means the process is in a state the code never
// planned for. Log it through the redacted sink (so it pages), then exit non-zero
// and let the supervisor restart a clean process. Node's default for both is to
// crash anyway; the difference is that it would crash silently to stderr. Never
// try to "keep going" here: a half-alive worker that holds BullMQ locks but no
// longer processes is the worst outcome, because the heartbeat may keep beating.
process.on("uncaughtException", (err) => {
  void logger
    .reportError("worker uncaught exception; exiting for supervisor restart", err)
    .finally(() => process.exit(1));
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  void logger
    .reportError("worker unhandled rejection; exiting for supervisor restart", err)
    .finally(() => process.exit(1));
});

const SWEEP_JOB = "scheduled_sweep";
const SWEEP_SCHEDULER = "cron-15min";
// Concurrent jobs this worker processes. For a single campaign, effective send
// parallelism is min(SEND_LANES, WORKER_CONCURRENCY × replicas), so this must be
// at or above SEND_LANES to saturate the lanes. The default leaves headroom
// ABOVE the lanes on purpose: one campaign that fills every slot would otherwise
// make a priority-1 transactional email wait for a whole batch to finish (~100
// paced sends, a minute at a fresh account's rate) before it can even start.
// Size DB_POOL_MAX to match (see src/db/client.ts). NaN-safe parse: an env typo
// must fall back to the default, not spin up a NaN-concurrency worker.
const CONCURRENCY = envInt("WORKER_CONCURRENCY", SEND_LANES + 4, 1, 64);

// The automation dispatcher tick (docs/automations-design.md §5.2). Its own
// repeatable job, not a branch of the 15-minute sweep: a welcome email that
// arrives up to 15 minutes after signup reads as broken. Bounded at 15s so a
// typo cannot turn it into a hot loop, and at 10 min so it stays a dispatcher
// rather than a batch.
const AUTOMATION_TICK_SCHEDULER = "automation-tick";
const AUTOMATION_TICK_SECONDS = envInt("AUTOMATION_TICK_SECONDS", 60, 15, 600);

// How long shutdown() waits for in-flight jobs before exiting anyway. Must be
// SHORTER than the supervisor's kill timeout (ecosystem.config.cjs sets pm2's
// kill_timeout to 60 s; systemd's TimeoutStopSec defaults to 90 s), so the
// process always leaves on its own terms with its logs written. Long enough for
// a batch to finish the one send it has in flight (SES request timeout is 15 s)
// and hand the rest back.
const SHUTDOWN_DEADLINE_MS = envInt("WORKER_SHUTDOWN_DEADLINE_MS", 45_000, 5_000, 300_000);

function makeConnection(): IORedis {
  const url = process.env.REDIS_URL;
  if (!url) throw new Error("REDIS_URL is not set");
  // rediss:// enables TLS automatically. maxRetriesPerRequest:null is required
  // for BullMQ's blocking Worker connection.
  return new IORedis(url, {
    maxRetriesPerRequest: null,
    // TCP keepalive with a 10 s initial delay. ioredis' default of 0 enables
    // keepalive but leaves the delay to the OS (2 hours on Linux), which is how
    // long a half-open socket — the VPS's NAT or Redis's own timeout dropped the
    // connection without a FIN — would go undetected. BullMQ guards its blocking
    // connection itself (it reconnects when BZPOPMIN overstays); this covers the
    // non-blocking ones the pacer, the heartbeat and every enqueue go through.
    keepAlive: 10_000,
    // Cap the reconnect backoff so an outage costs a few attempts per minute
    // and recovery is prompt once Redis is back.
    retryStrategy: (times) => Math.min(times * 200, 5_000),
  });
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
  async send(message: QueueMessage, opts?: { delayMs?: number }) {
    await queue.add(message.type, message, jobOptionsFor(message.type, opts));
  },
};

// Webhook emission happens deep inside services (addSuppression, the SES event
// recorder) that have no queue in scope and no business growing one in their
// signature. Register this tier's queue as the ambient one so those call sites
// enqueue through the worker's existing connection instead of opening a second.
setAmbientQueue(jobQueue);

// Flipped by shutdown() before worker.close(). Long-running handlers (the send
// batch loop) poll it between recipients and return their unsent remainder to
// pending, so a routine deploy never leaves claimed rows behind to be swept
// 15 minutes later.
let draining = false;

// Outbound mail is paced to the provider's approved sends-per-second before it
// reaches the provider at all, so no send path can forget to opt in: the lanes of
// one campaign, the lanes of a *concurrent* campaign, transactional sends and
// form confirmations all draw down the one ceiling SES enforces per AWS account.
// Without this the lanes send as fast as the socket allows (~50/s at the
// defaults), which overruns a fresh account's 14/s within seconds and pauses the
// campaign for 10+ minutes. Shares queueConnection: one Redis round-trip per
// email on an already-open non-blocking connection, and the pacer bounds its own
// waits so a Redis stall degrades to unpaced sending rather than to no sending.
const baseEmailProvider = emailProviderFromEnv();
const sendPacer = createSendPacer({
  store: queueConnection,
  discover: baseEmailProvider.maxSendRate
    ? () => baseEmailProvider.maxSendRate!()
    : undefined,
});

// The pacer's sibling: the per-second ceiling is a queueing problem, the
// 24-hour one is a cliff that stops every tenant at once. The budget meters
// every send against the provider's daily quota, holds campaign and automation
// mail back before SES has to reject it (so signup confirmations still get
// through), pages when usage crosses 70/90/98%, and tells the sweep when there
// is room to resume. Wrapped OUTSIDE the pacer so a send that will be held does
// not first wait for, or consume, a rate slot.
const sendBudget = createSendBudget({
  store: queueConnection,
  quota: baseEmailProvider.sendQuota ? () => baseEmailProvider.sendQuota!() : undefined,
});

const deps: QueueDeps = {
  db: getDb(),
  queue: jobQueue,
  emailProvider: withSendBudget(withSendPacing(baseEmailProvider, sendPacer), sendBudget),
  store: createSupabaseObjectStore(),
  appUrl: requireAppUrl(),
  unsubscribeSecret: requireUnsubscribeSecret(),
  aiReviewMode: process.env.AI_REVIEW_MODE,
  shouldAbort: () => draining,
};

// Resolve the rate before consuming, so the first campaign of a boot is paced
// and the effective rate is in the startup logs. Best-effort by construction:
// warmUp falls back to the conservative default rather than throwing.
await sendPacer.warmUp();
// Same reasoning for the budget: resolve the daily ceiling before consuming, so
// the first campaign of a boot is metered and the headroom is in the startup
// logs. Best-effort by construction, an unreadable quota means unmetered.
await sendBudget.warmUp();

const workerConnection = makeConnection();
const worker = new Worker(
  QUEUE_NAME,
  async (job) => {
    if (job.name === SWEEP_JOB) {
      await runScheduledSweeps({ db: deps.db, queue: deps.queue, sendBudget });
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

// The two repeatable schedulers this process depends on. Upserting is
// idempotent (same key → same schedule), so this is safe to call as often as we
// like — and we do call it more than once, deliberately:
//   - at boot, obviously;
//   - on every Redis reconnect (queueConnection "ready" after the first), because
//     a Redis that came back empty — restarted without AOF, failed over to a cold
//     replica, FLUSHALL'd by mistake — has lost the scheduler keys, and nothing
//     else would ever recreate them until the worker itself restarted. Every
//     sweep-driven recovery (stuck locks, stranded transactional rows, scheduled
//     campaigns, auto-resume) would silently stop; /api/health would only say so
//     40 minutes later;
//   - and periodically from the heartbeat loop, for the same reason, in case the
//     reconnect event was missed.
async function ensureSchedulers(reason: string): Promise<void> {
  try {
    // Repeatable cron sweep every 15 minutes (replaces the CF `scheduled` trigger):
    // stuck-lock recovery, sending-campaign reconcile, daily health, monthly reset.
    await queue.upsertJobScheduler(
      SWEEP_SCHEDULER,
      { pattern: "0 */15 * * * *" },
      { name: SWEEP_JOB, data: {} },
    );
    // The tick is an ordinary queue message (type: automation_tick) so it routes
    // through handleQueueMessage like everything else. attempts: 1 because the
    // next tick IS the retry; a failed pass is dead-lettered into job_logs where
    // it is visible instead of retried five times on top of the following tick.
    await queue.upsertJobScheduler(
      AUTOMATION_TICK_SCHEDULER,
      { every: AUTOMATION_TICK_SECONDS * 1000 },
      {
        name: "automation_tick",
        data: { type: "automation_tick" } satisfies QueueMessage,
        opts: { ...jobOptionsFor("automation_tick"), attempts: 1 },
      },
    );
    logger.info("job schedulers registered", {
      reason,
      sweep: { scheduler: SWEEP_SCHEDULER, pattern: "every 15 min" },
      automationTick: { scheduler: AUTOMATION_TICK_SCHEDULER, everySeconds: AUTOMATION_TICK_SECONDS },
    });
  } catch (err) {
    // Best-effort: the next reconnect or heartbeat interval tries again. Loud,
    // because until it succeeds no sweep runs.
    void logger.reportError("job scheduler registration failed", err, { reason });
  }
}
await ensureSchedulers("boot");

let readyEvents = 0;
queueConnection.on("ready", () => {
  readyEvents += 1;
  if (readyEvents === 1) return; // the initial connect; boot registered them
  logger.warn("redis reconnected; re-registering job schedulers", { reconnects: readyEvents - 1 });
  void ensureSchedulers("redis reconnect");
});

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
// Every Nth beat also re-asserts the schedulers (see ensureSchedulers). At the
// 30 s heartbeat this is every 5 minutes: cheap (two idempotent upserts), and
// it bounds how long a lost scheduler can stay lost to one sweep interval.
const SCHEDULER_REASSERT_EVERY_BEATS = 10;
let beats = 0;
async function beat(): Promise<void> {
  try {
    if (!(await workerAlive())) {
      logger.warn("heartbeat skipped: worker connection not responding");
      return;
    }
    await writeHeartbeat(queueConnection);
    beats += 1;
    if (beats % SCHEDULER_REASSERT_EVERY_BEATS === 0) await ensureSchedulers("periodic");
  } catch (err) {
    logger.warn("heartbeat write failed", { error: err instanceof Error ? err.message : String(err) });
  }
}
await beat();
const heartbeatTimer = setInterval(() => void beat(), HEARTBEAT_INTERVAL_MS);
heartbeatTimer.unref();

let shuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return; // a second signal must not start a second drain
  shuttingDown = true;
  logger.info("worker shutting down", { signal, deadlineMs: SHUTDOWN_DEADLINE_MS });
  // Signal in-flight send batches to stop between recipients and return their
  // unsent remainder to pending BEFORE closing the worker: worker.close() waits
  // for active jobs, and supervisors (pm2/systemd/Docker) SIGKILL long before a
  // full batch of serial sends would finish on its own.
  draining = true;
  clearInterval(heartbeatTimer);

  // The drain is bounded. A job wedged on a dead socket would otherwise hold
  // worker.close() open until the supervisor's SIGKILL — which is the same
  // outcome, minus the exit log and minus the guarantee that it happens at all
  // under a supervisor with no kill timeout. Whatever is still claimed when the
  // deadline fires is the sweep's to resolve, exactly as after a hard crash.
  const deadline = new Promise<"timeout">((resolve) => {
    const t = setTimeout(() => resolve("timeout"), SHUTDOWN_DEADLINE_MS);
    t.unref();
  });
  const drain = (async () => {
    await worker.close();
    await queue.close();
    await queueConnection.quit();
    await workerConnection.quit();
    return "clean" as const;
  })();

  let code = 0;
  try {
    const outcome = await Promise.race([drain, deadline]);
    if (outcome === "timeout") {
      code = 1;
      logger.error("worker shutdown deadline hit; exiting with jobs still active", {
        deadlineMs: SHUTDOWN_DEADLINE_MS,
      });
    }
  } catch (err) {
    code = 1;
    logger.error("worker shutdown did not drain cleanly", {
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    process.exit(code);
  }
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
