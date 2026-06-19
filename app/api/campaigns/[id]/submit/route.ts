import { and, eq, sql } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign, findDomain } from "@/api/finders";
import { campaigns, subscribers } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { checkSendEligibility } from "@/services/plans";
import { getQueue } from "@/queue/producer";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");

  const eligibility = checkSendEligibility(account);
  if (!eligibility.allowed) throw new HttpError(403, eligibility.reason);

  if (campaign.status !== "draft" && campaign.status !== "approved") {
    throw new HttpError(409, `Campaign cannot be submitted from status "${campaign.status}"`);
  }

  // Re-fetch the sending domain scoped to the account (never by primary id
  // alone) so a cross-tenant id can never satisfy the verified check.
  const domain = await findDomain(db, account.id, campaign.sendingDomainId);
  const domainVerified =
    domain && (domain.verificationStatus === "verified" || domain.adminOverrideVerified);
  if (!domainVerified) {
    throw new HttpError(403, "Sending domain is not verified");
  }

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(subscribers)
    .where(
      and(eq(subscribers.audienceId, campaign.audienceId), eq(subscribers.status, "subscribed")),
    );
  if (Number(count) === 0) {
    throw new HttpError(400, "The audience has no subscribed recipients");
  }

  await db
    .update(campaigns)
    .set({ status: "pending_review", pausedReason: null, updatedAt: nowIso() })
    .where(eq(campaigns.id, campaign.id));

  await getQueue().send({
    type: "review_campaign",
    campaignId: campaign.id,
    accountId: account.id,
  });
  return json({ ok: true });
});
