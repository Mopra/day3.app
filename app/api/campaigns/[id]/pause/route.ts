import { and, eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { campaigns } from "@/db/schema";
import { nowIso } from "@/lib/ids";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");
  if (campaign.status !== "sending") {
    throw new HttpError(409, "Only a sending campaign can be paused");
  }
  // pausedCode "user" is the one pause the cron sweep must never auto-resume.
  await db
    .update(campaigns)
    .set({ status: "paused", pausedReason: "Paused by user.", pausedCode: "user", updatedAt: nowIso() })
    .where(and(eq(campaigns.id, campaign.id), eq(campaigns.status, "sending")));
  return json({ ok: true });
});
