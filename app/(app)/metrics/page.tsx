import { requireAccount } from "@/api/context";
import { accountCampaignMetrics } from "@/services/metrics";
import { MetricsView } from "./metrics-view";

// Server-rendered — see the note in ../campaigns/page.tsx. The whole page is
// derived from this one read, so the filter and the table stay client-side.
export default async function MetricsPage() {
  const { db, account } = await requireAccount();
  return <MetricsView rows={await accountCampaignMetrics(db, account.id)} />;
}
