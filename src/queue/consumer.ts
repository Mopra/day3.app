import type { Db } from "../db/client";
import type { EmailProvider } from "../email/provider";
import type { ObjectStore } from "../lib/storage";
import { logJob } from "../lib/job-log";
import type { JobQueue, QueueMessage } from "./messages";
import { processImport } from "./handlers/process-import";
import { reviewCampaign } from "./handlers/review-campaign";
import { generateCampaignRecipients } from "./handlers/generate-recipients";
import { sendCampaignBatch } from "./handlers/send-batch";

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
};

export async function handleQueueMessage(message: QueueMessage, deps: QueueDeps): Promise<void> {
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
