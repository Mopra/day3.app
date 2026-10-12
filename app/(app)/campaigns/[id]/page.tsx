import { redirect } from "next/navigation";
import { requireAccount, requireOnboardingState } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { readCampaignDetail } from "@/api/campaign-detail";
import { listAudiences, listDomains } from "@/api/lists";
import { listSendersWithDomain } from "@/api/senders";
import { CampaignDetailView } from "./campaign-detail-view";

// The campaign is read here, not in a mount effect, so the first click on
// "Write my first email" lands on the draft instead of a skeleton waiting on
// two more round trips. The view keeps polling `GET /api/campaigns/[id]` while a
// send is in flight; both read through `readCampaignDetail`.
export default async function CampaignDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const campaign = await findCampaign(db, account.id, id);
  // Deleted, or the user switched workspace with a link to another one's campaign.
  if (!campaign) redirect("/campaigns");
  // A draft opens in the composer, whose pickers would otherwise fetch on mount
  // and show a bare audience id until the list arrived.
  const isDraft = campaign.status === "draft";
  const [detail, onboarding, lookups] = await Promise.all([
    readCampaignDetail(db, account, campaign),
    requireOnboardingState(),
    isDraft
      ? Promise.all([
          listAudiences(db, account.id),
          listDomains(db, account.id),
          listSendersWithDomain(db, account.id),
        ])
      : null,
  ]);
  return (
    <CampaignDetailView
      key={id}
      initial={detail}
      initialOnboarding={onboarding}
      composerLookups={
        lookups
          ? { audiences: lookups[0], domains: lookups[1], senders: lookups[2], account }
          : null
      }
    />
  );
}
