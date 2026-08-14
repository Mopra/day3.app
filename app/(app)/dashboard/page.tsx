import { requireAccount } from "@/api/context";
import { listCampaigns } from "@/api/lists";
import { computeAccountHealth } from "@/services/health";
import { computeOnboardingState } from "@/services/onboarding";
import { DashboardView } from "./dashboard-view";

// The dashboard was the worst case of the fetch-on-mount pattern: three requests
// from the client (account+health, onboarding, campaigns), each re-resolving the
// account before doing its own work, and none of them able to start until the RSC
// navigation had already completed. All of it is read here now, concurrently, on
// one connection — and `requireAccount` is memoized per request, so the account
// row is fetched once for all three rather than once each.
export default async function DashboardPage() {
  const { db, account } = await requireAccount();
  const [health, onboarding, campaigns] = await Promise.all([
    computeAccountHealth(db, account.id),
    computeOnboardingState(db, account),
    listCampaigns(db, account.id),
  ]);
  return (
    <DashboardView
      account={account}
      health={health}
      onboarding={onboarding}
      // Only the five most recent are shown; "View all" goes to /campaigns.
      campaigns={campaigns.slice(0, 5)}
    />
  );
}
