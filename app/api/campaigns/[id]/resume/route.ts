import { and, eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { campaigns } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { checkSendEligibility } from "@/services/plans";
import { SEND_BATCH_SIZE } from "@/queue/messages";
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
    .set({ status: "sending", pausedReason: null, updatedAt: nowIso() })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "paused")));

  await getQueue().send({
    type: "send_campaign_batch",
    campaignId: campaign.id,
    accountId: account.id,
    batchSize: SEND_BATCH_SIZE,
  });
  return json({ ok: true });
});
