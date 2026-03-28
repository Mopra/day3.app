export const dynamic = "force-dynamic";

import { redirect, notFound } from "next/navigation";
import { getCurrentUserProfile } from "@/server/actions/user";
import { fetchCampaignById } from "@/server/actions/campaigns";
import { EditCampaignForm } from "@/components/campaigns/edit-campaign-form";

export default async function EditCampaignPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const user = await getCurrentUserProfile();
  if (!user) redirect("/sign-in");

  const { id } = await params;
  const campaign = await fetchCampaignById(id);
  if (!campaign) notFound();

  return (
    <div className="max-w-2xl">
      <EditCampaignForm campaign={campaign} />
    </div>
  );
}
