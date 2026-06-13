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
