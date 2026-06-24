import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { accountCampaignMetrics } from "@/services/metrics";

// Per-campaign send metrics for the current account. The page computes the
// global totals and all rates client-side from these rows, so the campaign
// filter is instant and needs no extra request.
export const GET = route(async () => {
  const { db, account } = await requireAccount();
  const campaigns = await accountCampaignMetrics(db, account.id);
  return json({ campaigns });
});
