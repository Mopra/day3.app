import { eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { campaigns } from "@/db/schema";
import { nowIso } from "@/lib/ids";

// Cancels a pending schedule, returning the campaign to "draft" so it can be
// edited again. Only valid while still parked in "scheduled" (before the cron
// release hands it to the send pipeline).
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");
  if (campaign.status !== "scheduled") {
    throw new HttpError(409, "Only scheduled campaigns can be unscheduled");
  }

  await db
    .update(campaigns)
    .set({ status: "draft", scheduledAt: null, updatedAt: nowIso() })
    .where(eq(campaigns.id, campaign.id));
  return json({ ok: true });
});
