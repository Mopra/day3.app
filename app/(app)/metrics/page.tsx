import { requireAccount } from "@/api/context";
import {
  accountAutomationMetrics,
  accountCampaignMetrics,
  accountReputation,
  accountTransactionalMetrics,
} from "@/services/metrics";
import { MetricsView } from "./metrics-view";

// Server-rendered — see the note in ../campaigns/page.tsx. The four reads run
// concurrently and the whole page is derived from them, so the scope filter and
// the tables stay client-side.
//
// Four reads rather than one because the page shows three different kinds of
// number: what marketing mail did (campaigns + automations, which share a
// ledger and a shape), what API mail did (a different ledger with no opens or
// clicks in it), and what the account's reputation is (account-wide over a
// trailing window, computed by the same function that pauses sending).
export default async function MetricsPage() {
  const { db, account } = await requireAccount();
  const [campaigns, automations, transactional, reputation] = await Promise.all([
    accountCampaignMetrics(db, account.id),
    accountAutomationMetrics(db, account.id),
    accountTransactionalMetrics(db, account.id),
    accountReputation(db, account.id),
  ]);
  return (
    <MetricsView
      campaigns={campaigns}
      automations={automations}
      transactional={transactional}
      reputation={reputation}
    />
  );
}
