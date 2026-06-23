import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { campaignSendGateError } from "@/api/campaigns";
import { campaigns } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { checkSendEligibility } from "@/services/plans";
import { enforceRateLimit } from "@/lib/rate-limit";

const ScheduleSchema = z.object({ scheduledAt: z.string().min(1) });

// Schedules a draft to send at a future time. The campaign parks in "scheduled"
// with a `scheduledAt`; the 15-minute cron sweep (releaseDueCampaigns) moves it
// into the normal review→send pipeline once that time passes. Gates mirror the
// submit route so a campaign can never be scheduled into a state it couldn't be
// sent from — but they are re-checked again at release time.
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  await enforceRateLimit("campaign_submit", account.id);
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");

  const eligibility = checkSendEligibility(account);
  if (!eligibility.allowed) throw new HttpError(403, eligibility.reason);

  // Schedule from an editable draft, or re-schedule one already parked.
  if (campaign.status !== "draft" && campaign.status !== "scheduled") {
    throw new HttpError(409, `Campaign cannot be scheduled from status "${campaign.status}"`);
  }

  const { scheduledAt } = await parseJson(req, ScheduleSchema);
  const when = new Date(scheduledAt);
  if (Number.isNaN(when.getTime())) throw new HttpError(400, "Invalid schedule time");
  if (when.getTime() < Date.now() + 60_000) {
    throw new HttpError(400, "Pick a time at least a minute from now");
  }

  const gateError = await campaignSendGateError(db, account.id, campaign);
  if (gateError) throw new HttpError(gateError.includes("verified") ? 403 : 400, gateError);

  await db
    .update(campaigns)
    .set({
      status: "scheduled",
      scheduledAt: when.toISOString(),
      pausedReason: null,
      updatedAt: nowIso(),
    })
    .where(eq(campaigns.id, campaign.id));
  return json({ ok: true, scheduledAt: when.toISOString() });
});
