import { eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { campaigns } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { getQueue } from "@/queue/producer";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db } = await requireAdmin();
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
  if (!campaign) throw new HttpError(404, "Not found");
  if (campaign.status !== "blocked" && campaign.status !== "pending_review") {
    throw new HttpError(409, `Cannot approve from status "${campaign.status}"`);
  }

  await db
    .update(campaigns)
    .set({ status: "approved", pausedReason: null, updatedAt: nowIso() })
    .where(eq(campaigns.id, campaign.id));
  await getQueue().send({
    type: "generate_campaign_recipients",
    campaignId: campaign.id,
    accountId: campaign.accountId,
  });
  return json({ ok: true });
});
