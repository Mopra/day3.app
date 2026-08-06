import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { enforceRateLimit } from "@/lib/rate-limit";
import { scheduleCampaign } from "@/services/campaign-send";

const ScheduleSchema = z.object({ scheduledAt: z.string().min(1) });

// Parks a draft to send at a future time; the 15-minute cron sweep releases it.
// Gates live in services/campaign-send, shared with the public API's twin.
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  await enforceRateLimit("campaign_submit", account.id);
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");

  const { scheduledAt } = await parseJson(req, ScheduleSchema);
  const when = await scheduleCampaign(db, account, campaign, new Date(scheduledAt));
  return json({ ok: true, scheduledAt: when });
});
