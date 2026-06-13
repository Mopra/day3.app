import { createDb } from "../db/client";
import { createEmailProvider } from "../email/factory";
import { logJob } from "../lib/job-log";
import type { QueueMessage } from "./messages";
import { processImport } from "./handlers/process-import";
import { reviewCampaign } from "./handlers/review-campaign";
import { generateCampaignRecipients } from "./handlers/generate-recipients";
import { sendCampaignBatch } from "./handlers/send-batch";

export async function handleQueueMessage(message: QueueMessage, env: Env): Promise<void> {
  const db = createDb(env.DB);

  switch (message.type) {
    case "process_import":
      return processImport(message, db, env.IMPORTS_BUCKET);
    case "review_campaign":
      return reviewCampaign(message, db, env.JOBS_QUEUE, env.AI_REVIEW_MODE);
    case "generate_campaign_recipients":
      return generateCampaignRecipients(message, db, env.JOBS_QUEUE);
    case "send_campaign_batch":
      return sendCampaignBatch(message, {
        db,
        jobsQueue: env.JOBS_QUEUE,
        emailProvider: createEmailProvider(env),
        appUrl: env.APP_URL,
        unsubscribeSecret: env.UNSUBSCRIBE_SECRET,
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

export async function handleQueueBatch(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    try {
      await handleQueueMessage(message.body, env);
      message.ack();
    } catch (err) {
      console.error(`[queue] ${message.body.type} failed (attempt ${message.attempts})`, err);
      // Exponential-ish backoff; the queue's max_retries + DLQ catch repeats.
      message.retry({ delaySeconds: Math.min(60 * message.attempts, 600) });
    }
  }
}
