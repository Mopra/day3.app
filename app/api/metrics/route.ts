import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import {
  accountAutomationMetrics,
  accountCampaignMetrics,
  accountReputation,
  accountTransactionalMetrics,
} from "@/services/metrics";

// Send metrics for the current account: the same four reads the Metrics page
// makes on the server, through the same functions (AGENTS.md — one
// implementation, two front doors). The page computes every rate client-side
// from these, so the scope filter is instant and needs no extra request.
export const GET = route(async () => {
  const { db, account } = await requireAccount();
  const [campaigns, automations, transactional, reputation] = await Promise.all([
    accountCampaignMetrics(db, account.id),
    accountAutomationMetrics(db, account.id),
    accountTransactionalMetrics(db, account.id),
    accountReputation(db, account.id),
  ]);
  return json({ campaigns, automations, transactional, reputation });
});
