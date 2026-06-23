"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useApi } from "@/lib/api";
import { CampaignComposer, type CampaignFormValues } from "@/components/campaign-composer";

export default function CampaignNewPage() {
  const api = useApi();
  const router = useRouter();

  async function onSave(values: CampaignFormValues) {
    const res = await api.post<{ id: string }>("/api/campaigns", values);
    toast.success("Draft saved");
    router.push(`/campaigns/${res.id}`);
  }

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">New campaign</h1>
      <CampaignComposer onSave={onSave} submitLabel="Save draft" />
    </div>
  );
}
