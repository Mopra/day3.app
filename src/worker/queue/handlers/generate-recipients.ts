import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { campaignRecipients, campaigns, subscribers } from "../../db/schema";
import { newId, nowIso } from "../../lib/ids";
import { logJob } from "../../lib/job-log";
import { getSuppressedEmails } from "../../services/suppression";
import { SEND_BATCH_SIZE, type QueueMessage } from "../messages";

// campaign_recipients has 19 columns; 5 rows/statement stays under D1's
// 100-bound-parameter limit.
const INSERT_CHUNK = 5;

export async function generateCampaignRecipients(
  message: { campaignId: string; accountId: string },
  db: Db,
  jobsQueue: Queue<QueueMessage>,
): Promise<void> {
  const campaign = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, message.campaignId), eq(campaigns.accountId, message.accountId)),
  });

  // Idempotency: "approved" is the entry state; "generating_recipients" means
  // a previous attempt crashed mid-way — resuming is safe because inserts
  // dedupe on (campaign_id, email).
  if (!campaign || (campaign.status !== "approved" && campaign.status !== "generating_recipients")) {
    await logJob(db, {
      jobType: "generate_campaign_recipients",
      entityType: "campaign",
      entityId: message.campaignId,
      status: "skipped",
      error: campaign ? `status is ${campaign.status}` : "campaign not found",
    });
    return;
  }

  await db
    .update(campaigns)
    .set({ status: "generating_recipients", updatedAt: nowIso() })
    .where(eq(campaigns.id, campaign.id));

  const audienceMembers = await db
    .select({
      id: subscribers.id,
      email: subscribers.email,
    })
    .from(subscribers)
    .where(
      and(
        eq(subscribers.accountId, campaign.accountId),
        eq(subscribers.audienceId, campaign.audienceId),
        eq(subscribers.status, "subscribed"),
      ),
    );

  const suppressed = await getSuppressedEmails(
    db,
    campaign.accountId,
    audienceMembers.map((s) => s.email),
  );
  const eligible = audienceMembers.filter((s) => !suppressed.has(s.email.toLowerCase()));

  const now = nowIso();
  for (let i = 0; i < eligible.length; i += INSERT_CHUNK) {
    const chunk = eligible.slice(i, i + INSERT_CHUNK);
    await db
      .insert(campaignRecipients)
      .values(
        chunk.map((s) => ({
          id: newId("rcp"),
          campaignId: campaign.id,
          accountId: campaign.accountId,
          subscriberId: s.id,
          email: s.email,
          status: "pending" as const,
          provider: "cloudflare",
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing();
  }

  await db
    .update(campaigns)
    .set({ status: "sending", updatedAt: nowIso() })
    .where(eq(campaigns.id, campaign.id));

  await jobsQueue.send({
    type: "send_campaign_batch",
    campaignId: campaign.id,
    accountId: campaign.accountId,
    batchSize: SEND_BATCH_SIZE,
  });

  await logJob(db, {
    jobType: "generate_campaign_recipients",
    entityType: "campaign",
    entityId: campaign.id,
    status: "completed",
    payload: { audience: audienceMembers.length, eligible: eligible.length },
  });
}
