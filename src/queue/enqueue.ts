import { logger } from "../lib/logger";
import type { JobQueue, QueueMessage } from "./messages";

// The ambient job queue, for enqueue sites that sit too deep to be handed one.
//
// Almost every producer in the codebase takes a `JobQueue` explicitly, and that
// stays the rule — an API route or a queue handler always has one in scope, and
// passing it is clearer than reaching for a global. This exists for exactly one
// shape of call site: webhook emission, which fires from inside
// `addSuppression` and the SES event recorder. Those are leaf functions called
// from a dozen places (the SES route, the send batch, the unsubscribe action,
// the CSV import, the public API); threading a queue parameter through all of
// them would put transport plumbing in every signature between here and there,
// to serve one optional side effect.
//
// Registration is per-tier and happens once at boot:
//   - worker/index.ts registers the worker's own BullMQ queue, so emission
//     reuses the connection the worker already holds.
//   - the web tier falls back to the lazy producer queue (src/queue/producer.ts),
//     which is the same connection its route handlers enqueue through.
//   - tests register a FakeQueue, or register nothing at all — see below.
let ambient: JobQueue | undefined;

export function setAmbientQueue(queue: JobQueue | undefined): void {
  ambient = queue;
}

/**
 * Enqueue through the ambient queue, or the web tier's producer queue if none
 * was registered.
 *
 * NEVER THROWS. Every caller is a side effect on a path whose real work has
 * already succeeded — the bounce was recorded, the address was suppressed — and
 * a Redis blip must not roll that back or 500 a provider webhook that SNS will
 * then redeliver. A failed enqueue is logged and dropped here; the row it would
 * have driven is already `pending` in Postgres, and the cron sweep
 * (sweepWebhookDeliveries) picks up anything that never got a job. That makes
 * the queue a latency optimization over a Postgres-backed outbox rather than the
 * thing correctness depends on — which is also why tests can exercise emission
 * without a queue at all.
 */
export async function enqueueBestEffort(
  message: QueueMessage,
  opts?: { delayMs?: number },
): Promise<boolean> {
  try {
    const queue = ambient ?? (await import("./producer")).getQueue();
    await queue.send(message, opts);
    return true;
  } catch (err) {
    void logger.reportError("best-effort enqueue failed (cron sweep will recover)", err, {
      jobType: message.type,
    });
    return false;
  }
}
