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
    };

export const SEND_BATCH_SIZE = 25;

// The single BullMQ queue both tiers share: the web tier (producer) adds jobs,
// the VPS worker (consumer) processes them. Kept here (no bullmq import) so both
// sides reference the same name without pulling in the driver.
export const QUEUE_NAME = "day3-jobs";

// Retry policy applied to every enqueued job (mirrors the old CF queue's
// max_retries + backoff). Retries are safe because the handlers are idempotent
// on DB status; exhausted jobs land in BullMQ's "failed" set (the DLQ).
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
