export type QueueMessage =
  | {
      type: "process_import";
      importId: string;
      accountId: string;
    }
  | {
      type: "review_campaign";
      campaignId: string;
      accountId: string;
    }
  | {
      type: "generate_campaign_recipients";
      campaignId: string;
      accountId: string;
    }
  | {
      type: "send_campaign_batch";
      campaignId: string;
      accountId: string;
      batchSize: number;
    }
  | {
      type: "process_email_event";
      eventId: string;
    }
  | {
      // Double opt-in confirmation email for a public-form signup. ID-only: the
      // worker re-reads the subscriber + form + account, signs the confirm token,
      // and sends via the account's verified sending domain.
      type: "send_form_confirmation";
      subscriberId: string;
      accountId: string;
    };

// How many recipients one `send_campaign_batch` job claims and sends (serially,
// in-process) before handing off. Larger batches amortize the per-batch DB
// round-trips (claim + reconcile) over more emails. Env-tunable.
export const SEND_BATCH_SIZE = Math.max(1, Number(process.env.SEND_BATCH_SIZE ?? "100"));

// How many independent `send_campaign_batch` jobs (\"lanes\") are fanned out for a
// single campaign. Each lane is a self-chaining batch that claims a *disjoint*
// slice of pending recipients via `FOR UPDATE SKIP LOCKED`, so N lanes drain a
// campaign ~N× faster than the old single self-chaining batch. Effective
// parallelism is min(SEND_LANES, WORKER_CONCURRENCY × worker replicas), so set
// WORKER_CONCURRENCY to at least SEND_LANES to saturate it. Tune both to roughly
// your approved SES max send rate (a serial lane sustains ~1 send / network RTT;
// e.g. 8 lanes ≈ 50/s). Lane count is conserved — each batch enqueues at most one
// follow-up — so this never grows unbounded. The cap below is a safety ceiling.
export const SEND_LANES = Math.min(64, Math.max(1, Number(process.env.SEND_LANES ?? "8")));

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
