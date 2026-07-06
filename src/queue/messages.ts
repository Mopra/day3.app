import { z } from "zod";

// Every queue message shape, as a runtime schema. job.data crosses a trust
// boundary (Redis: producer version skew, operator replays, manual injection),
// so the consumer validates against this before dispatch — a malformed message
// must dead-letter loudly, not execute with garbage (e.g. a null batchSize
// would make reserveQuota grant 0 and pause a healthy campaign with a false
// "monthly limit reached"). The TS type is inferred from the schema so the two
// can never drift.
const id = z.string().min(1);
export const queueMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("process_import"), importId: id, accountId: id }),
  z.object({ type: z.literal("review_campaign"), campaignId: id, accountId: id }),
  z.object({ type: z.literal("generate_campaign_recipients"), campaignId: id, accountId: id }),
  z.object({
    type: z.literal("send_campaign_batch"),
    campaignId: id,
    accountId: id,
    batchSize: z.number(),
  }),
  z.object({ type: z.literal("process_email_event"), eventId: id }),
  // Double opt-in confirmation email for a public-form signup. ID-only: the
  // worker re-reads the subscriber + form + account, signs the confirm token,
  // and sends via the account's verified sending domain.
  z.object({ type: z.literal("send_form_confirmation"), subscriberId: id, accountId: id }),
  // Irreversible erasure of an account and everything it owns — enqueued when a
  // Clerk org is deleted, or when the last member of an org deletes their user
  // (see app/api/webhooks/clerk). ID-only; the worker re-reads and hard-deletes
  // every account-scoped row (see services/account-purge.ts) plus best-effort
  // external teardown. Idempotent: a retry after a partial run re-purges cleanly.
  z.object({ type: z.literal("purge_account"), accountId: id }),
]);
export type QueueMessage = z.infer<typeof queueMessageSchema>;

// Integer env knob with a default and hard bounds. Number("1,000") is NaN and
// Math.max(1, NaN) is NaN — an env typo must fall back to the default, never
// poison every enqueued message (NaN batchSize serializes to null in job data
// and breaks reserveQuota's SQL).
export function envInt(name: string, def: number, min: number, max: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? def : Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// Hard ceiling on recipients per batch, enforced both here (producer side) and
// in the send handler (server side, against stale/hand-crafted messages). The
// ceiling exists because a batch must comfortably finish inside the cron
// sweep's stuck-lock window even at worst-case per-send latency — the handler
// also refreshes locks mid-batch, but the cap keeps batches bounded work.
export const MAX_SEND_BATCH_SIZE = 500;

// How many recipients one `send_campaign_batch` job claims and sends (serially,
// in-process) before handing off. Larger batches amortize the per-batch DB
// round-trips (claim + reconcile) over more emails. Env-tunable.
export const SEND_BATCH_SIZE = envInt("SEND_BATCH_SIZE", 100, 1, MAX_SEND_BATCH_SIZE);

// How many independent `send_campaign_batch` jobs ("lanes") are fanned out for a
// single campaign. Each lane is a self-chaining batch that claims a *disjoint*
// slice of pending recipients via `FOR UPDATE SKIP LOCKED`, so N lanes drain a
// campaign ~N× faster than the old single self-chaining batch. Effective
// parallelism is min(SEND_LANES, WORKER_CONCURRENCY × worker replicas), so set
// WORKER_CONCURRENCY to at least SEND_LANES to saturate it. Tune both to roughly
// your approved SES max send rate (a serial lane sustains ~1 send / network RTT;
// e.g. 8 lanes ≈ 50/s). Lane count is conserved — each batch enqueues at most one
// follow-up, and the cron sweep only re-fans-out when no batch is in flight —
// so this never grows unbounded. The cap below is a safety ceiling.
export const SEND_LANES = envInt("SEND_LANES", 8, 1, 64);

// Lanes to enqueue for `pending` outstanding recipients: enough to saturate
// SEND_LANES, but never more lanes than there are batches of work. Shared by
// the initial fan-out (generate-recipients), the cron sweep's stall recovery,
// and the resume route so all three restore full send width.
export function laneCountFor(pending: number): number {
  return Math.max(1, Math.min(SEND_LANES, Math.ceil(pending / SEND_BATCH_SIZE)));
}

// The single BullMQ queue both tiers share: the web tier (producer) adds jobs,
// the VPS worker (consumer) processes them. Kept here (no bullmq import) so both
// sides reference the same name without pulling in the driver.
export const QUEUE_NAME = "day3-jobs";

// Bounded retry + backoff policy applied to every enqueued job. Retries are
// safe because handlers are idempotent on DB status, so a re-delivered message
// never double-sends — a retried `send_campaign_batch` only re-claims rows that
// are still `pending` (see send-batch.ts). The caps bound Redis memory; the
// dead-letter row written when a job exhausts `attempts` (see recordDeadLetter
// in lib/job-log.ts, wired from worker/index.ts) makes exhausted work
// observable in Postgres instead of only lingering in BullMQ's "failed" set.
//
// Per message type, the deliberate failure semantics are:
//   - send_campaign_batch: THROWS on transient errors (SES/DB/Redis enqueue
//     blip) → retried up to `attempts` with exponential backoff. Each retry
//     re-claims only `pending` rows, so duplicates are impossible. After the
//     last attempt the job is dead-lettered (logged + queryable). Per-recipient
//     permanent failures (bad address) are recorded as `failed` rows inline and
//     never throw, so they don't burn the whole batch's retries.
//   - generate_campaign_recipients / review_campaign: THROW on transient errors
//     → retried; inserts are dedupe-safe (onConflictDoNothing) so resuming a
//     crashed attempt can't duplicate.
//   - process_import: SWALLOWS errors by design (writes import.status='failed'
//     and returns) → never retried; a retry must not restart a failed import.
//   - process_email_event: webhook-driven; logged as skipped in the MVP.
export const DEFAULT_JOB_OPTIONS = {
  attempts: 5,
  backoff: { type: "exponential" as const, delay: 5000 },
  removeOnComplete: 1000,
  removeOnFail: 5000,
};

// Port seam for the job queue. The proven handler bodies enqueue follow-up work
// via `queue.send(msg)`. In production a BullMQ-backed adapter implements this
// (Phase 4); the test FakeQueue implements it directly — so the handlers never
// change when the underlying transport does.
export interface JobQueue {
  send(message: QueueMessage): Promise<void>;
}
