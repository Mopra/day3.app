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

  // First autosave creates the draft, then moves to its own page where autosave
  // continues. `replace` so Back doesn't return to the empty /new form.
  async function onAutosave(values: CampaignFormValues) {
    const res = await api.post<{ id: string }>("/api/campaigns", values);
    router.replace(`/campaigns/${res.id}`);
  }

  return (
    <div className="space-y-6">
      <CampaignComposer onSave={onSave} onAutosave={onAutosave} submitLabel="Save draft" />
    </div>
  );
}
