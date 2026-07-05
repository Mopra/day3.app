import { and, eq, sql } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { campaignRecipients, campaigns } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { checkSendEligibility } from "@/services/plans";
import { laneCountFor, SEND_BATCH_SIZE } from "@/queue/messages";
import { getQueue } from "@/queue/producer";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");
  if (campaign.status !== "paused") {
    throw new HttpError(409, "Only a paused campaign can be resumed");
  }

  const eligibility = checkSendEligibility(account);
  if (!eligibility.allowed) throw new HttpError(403, eligibility.reason);

  await db
    .update(campaigns)
    .set({ status: "sending", pausedReason: null, pausedCode: null, updatedAt: nowIso() })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "paused")));

  // Restore full lane width, not a single lane: a large campaign resumed with
  // one self-chaining batch would drain at 1/SEND_LANES of its designed rate
  // (lanes are conserved — nothing re-fans-out mid-send). Same fan-out rule as
  // the initial send and the sweep's stall recovery.
  const [{ pending }] = await db
    .select({ pending: sql<number>`count(*)`.as("pending") })
    .from(campaignRecipients)
    .where(
      and(
        eq(campaignRecipients.campaignId, campaign.id),
        eq(campaignRecipients.status, "pending"),
      ),
    );
  const lanes = Number(pending) > 0 ? laneCountFor(Number(pending)) : 1;
  const queue = getQueue();
  for (let lane = 0; lane < lanes; lane++) {
    await queue.send({
      type: "send_campaign_batch",
      campaignId: campaign.id,
      accountId: account.id,
      batchSize: SEND_BATCH_SIZE,
    });
  }
  return json({ ok: true });
});
