import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client";
import { campaignRecipients, campaigns, subscribers } from "../../db/schema";
import { canonicalizeEmail } from "../../lib/csv";
import { newId, nowIso } from "../../lib/ids";
import { logJob } from "../../lib/job-log";
import { getSuppressedEmails } from "../../services/suppression";
import { laneCountFor, SEND_BATCH_SIZE, type JobQueue } from "../messages";

// Postgres allows up to 65535 bound params per statement; chunk large audiences
// into comfortably-sized multi-row inserts.
const INSERT_CHUNK = 1000;

export async function generateCampaignRecipients(
  message: { campaignId: string; accountId: string },
  db: Db,
  jobsQueue: JobQueue,
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

  // Status-guarded: a stale duplicate delivery racing a completed run must not
  // knock a campaign that has already advanced to "sending" back to
  // "generating_recipients" (that would orphan its live lanes' follow-ups).
  await db
    .update(campaigns)
    .set({ status: "generating_recipients", updatedAt: nowIso() })
    .where(
      and(
        eq(campaigns.id, campaign.id),
        inArray(campaigns.status, ["approved", "generating_recipients"]),
      ),
    );

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
  const eligible = audienceMembers.filter((s) => !suppressed.has(canonicalizeEmail(s.email)));

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
          email: canonicalizeEmail(s.email),
          status: "pending" as const,
          provider: "ses",
          createdAt: now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing();
  }

  // Atomic claim of the generating_recipients → sending transition: only the
  // run that wins it fans out lanes, so a duplicate delivery (BullMQ is
  // at-least-once, and a stalled first attempt can still be running) can never
  // double the lane count and push send parallelism past the tuned SES rate.
  // If the winner crashes between this flip and the fan-out below, the cron
  // sweep's reconcile sees pending rows with nothing in flight and restores
  // full lane width within a sweep.
  const flipped = await db
    .update(campaigns)
    .set({ status: "sending", updatedAt: nowIso() })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "generating_recipients")))
    .returning({ id: campaigns.id });

  if (flipped.length > 0) {
    // Fan out independent send lanes so the worker actually sends in parallel.
    // Each lane is a self-chaining `send_campaign_batch` that claims a disjoint
    // slice of pending rows (FOR UPDATE SKIP LOCKED), so the lanes never collide
    // and never double-send. We never enqueue more lanes than there are batches
    // of work — a small audience still gets exactly one lane.
    const laneCount = laneCountFor(eligible.length);
    for (let lane = 0; lane < laneCount; lane++) {
      await jobsQueue.send({
        type: "send_campaign_batch",
        campaignId: campaign.id,
        accountId: campaign.accountId,
        batchSize: SEND_BATCH_SIZE,
      });
    }
  }

  await logJob(db, {
    jobType: "generate_campaign_recipients",
    entityType: "campaign",
    entityId: campaign.id,
    status: "completed",
    payload: { audience: audienceMembers.length, eligible: eligible.length },
  });
}
