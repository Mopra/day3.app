import type { Db } from "../db/client";
import type { EmailProvider } from "../email/provider";
import type { ObjectStore } from "../lib/storage";
import { logJob } from "../lib/job-log";
import { logger, newCorrelationId } from "../lib/logger";
import { queueMessageSchema, type JobQueue, type QueueMessage } from "./messages";
import { processImport } from "./handlers/process-import";
import { reviewCampaign } from "./handlers/review-campaign";
import { generateCampaignRecipients } from "./handlers/generate-recipients";
import { sendCampaignBatch } from "./handlers/send-batch";
import { sendFormConfirmation } from "./handlers/send-form-confirmation";
import { purgeAccount } from "./handlers/purge-account";

// Everything a queue handler can need, injected by the caller. The BullMQ worker
// process (worker/index.ts) builds this once and routes every job through
// handleQueueMessage; tests build it with fakes. This is the seam that used to
// be Cloudflare's `Env` (DB/queue/email/R2 bindings).
export type QueueDeps = {
  db: Db;
  queue: JobQueue;
  emailProvider: EmailProvider;
  store: ObjectStore;
  appUrl: string;
  unsubscribeSecret: string;
  aiReviewMode?: string;
  // Graceful-shutdown signal (worker/index.ts flips it on SIGTERM); long-running
  // handlers check it between units of work so a deploy interrupts cleanly.
  shouldAbort?: () => boolean;
};

// The entity a job acts on, for log correlation. Most messages carry an
// account-scoped entity; the entity id lets a single campaign / import be traced
// across the jobs it spawns. (process_email_event carries only an event id.)
function jobContext(message: QueueMessage): { entityType: string; entityId: string; accountId?: string } {
  switch (message.type) {
    case "process_import":
      return { entityType: "import", entityId: message.importId, accountId: message.accountId };
    case "review_campaign":
    case "generate_campaign_recipients":
    case "send_campaign_batch":
      return { entityType: "campaign", entityId: message.campaignId, accountId: message.accountId };
    case "process_email_event":
      return { entityType: "email_event", entityId: message.eventId };
    case "send_form_confirmation":
      return { entityType: "subscriber", entityId: message.subscriberId, accountId: message.accountId };
    case "purge_account":
      return { entityType: "account", entityId: message.accountId, accountId: message.accountId };
  }
}

// Wraps the dispatch with start/finish/duration logging and a per-job
// correlation id. Errors are reported (stack + safe context) and re-thrown so
// BullMQ still applies its retry/dead-letter policy unchanged.
export async function handleQueueMessage(message: QueueMessage, deps: QueueDeps): Promise<void> {
  // job.data crosses a trust boundary (producer version skew, operator replays,
  // manual Redis injection). A message with a valid type but missing ids would
  // otherwise be "handled" as a silent skip and vanish — validation makes it
  // throw, so BullMQ retries it and then dead-letters it where operators look.
  const parsed = queueMessageSchema.safeParse(message);
  if (!parsed.success) {
    throw new Error(
      `malformed queue message (${(message as { type?: string })?.type ?? "unknown type"}): ${parsed.error.message}`,
    );
  }
  const ctx = jobContext(message);
  const log = logger.child({ jobId: newCorrelationId("job"), jobType: message.type, ...ctx });
  const startedAt = Date.now();
  log.info("job started");
  try {
    await dispatchQueueMessage(message, deps);
    log.info("job finished", { durationMs: Date.now() - startedAt });
  } catch (err) {
    await log.reportError("job failed", err, { durationMs: Date.now() - startedAt });
    throw err;
  }
}

async function dispatchQueueMessage(message: QueueMessage, deps: QueueDeps): Promise<void> {
  const { db } = deps;

  switch (message.type) {
    case "process_import":
      return processImport(message, db, deps.store);
    case "review_campaign":
      return reviewCampaign(message, db, deps.queue, deps.aiReviewMode);
    case "generate_campaign_recipients":
      return generateCampaignRecipients(message, db, deps.queue);
    case "send_campaign_batch":
      return sendCampaignBatch(message, {
        db,
        jobsQueue: deps.queue,
        emailProvider: deps.emailProvider,
        appUrl: deps.appUrl,
        unsubscribeSecret: deps.unsubscribeSecret,
        shouldAbort: deps.shouldAbort,
      });
    case "send_form_confirmation":
      return sendFormConfirmation(message, {
        db,
        emailProvider: deps.emailProvider,
        confirmSecret: deps.unsubscribeSecret,
      });
    case "purge_account":
      return purgeAccount(message, {
        db,
        emailProvider: deps.emailProvider,
        store: deps.store,
      });
    case "process_email_event":
      // Provider event ingestion is webhook-driven for now; this exists so
      // the message type is routed when async event processing is added.
      return logJob(db, {
        jobType: "process_email_event",
        entityType: "email_event",
        entityId: message.eventId,
        status: "skipped",
        error: "not implemented in MVP",
      });
    default: {
      const unknown: never = message;
      throw new Error(`Unknown queue message type: ${JSON.stringify(unknown)}`);
    }
  }
}
