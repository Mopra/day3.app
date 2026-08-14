import { requireAccount } from "@/api/context";
import { listCampaigns } from "@/api/lists";
import { computeOnboardingState } from "@/services/onboarding";
import { CampaignsView } from "./campaigns-view";

// Server-rendered list. The rows and the onboarding strip are read here and handed
// to the client component as props, so the page paints its real content on the
// first frame.
//
// The client-fetch-on-mount version this replaces cost two SERIAL round trips per
// navigation: one for the RSC payload (which carried nothing but a reference to the
// client component), and only then — after the chunk loaded and React mounted and
// the effect ran — a second one for the data. Everything the user came to see
// waited for both. Reading it here collapses that to one.
//
// `GET /api/campaigns` still exists and still shares `listCampaigns`: the client
// component re-reads it after a mutation, and it's the same list either way.
export default async function CampaignsPage() {
  const { db, account } = await requireAccount();
  const [campaigns, onboarding] = await Promise.all([
    listCampaigns(db, account.id),
    computeOnboardingState(db, account),
  ]);
  return <CampaignsView initialCampaigns={campaigns} onboarding={onboarding} />;
}
