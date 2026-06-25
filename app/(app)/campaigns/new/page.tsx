"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CalendarClock } from "lucide-react";
import { useApi } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { statusLabel, statusVariant } from "@/lib/format";
import { CampaignComposer, type CampaignFormValues } from "@/components/campaign-composer";
import { CampaignActions } from "@/components/campaign-actions";

export default function CampaignNewPage() {
  const api = useApi();
  const router = useRouter();
  // The draft is created on the first autosave, then patched in place. We swap the
  // URL to the real campaign without a remount (history.replaceState) so editing is
  // never interrupted and a refresh lands on the saved draft. `creating` is a lock
  // so a burst of edits during the first save can't create duplicate drafts. Once
  // the draft exists we mirror its id into state so the real (working) send actions
  // can replace the disabled placeholders — without remounting the composer.
  const createdId = useRef<string | null>(null);
  const creating = useRef<Promise<string> | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);

  async function onAutosave(values: CampaignFormValues) {
    if (!createdId.current && !creating.current) {
      creating.current = api
        .post<{ id: string }>("/api/campaigns", values)
        .then((res) => {
          createdId.current = res.id;
          window.history.replaceState(null, "", `/campaigns/${res.id}`);
          setSavedId(res.id);
          return res.id;
        });
      await creating.current;
      return; // created with these values — nothing more to persist
    }
    // A create from a prior edit may still be in flight; wait for its id, then
    // patch with the latest values so nothing typed meanwhile is lost.
    const id = createdId.current ?? (await creating.current!);
    await api.patch(`/api/campaigns/${id}`, values);
  }

  // Before the draft exists, the send actions have nothing to act on, so they're
  // shown disabled as placeholders. The moment the first autosave creates the draft
  // (the URL has become /campaigns/<id>), they're swapped for the live actions —
  // no refresh, and the composer keeps its place since this page never remounts.
  const pendingActions = (
    <>
      <Button type="button" variant="outline" disabled title="Keep writing — your draft is saving automatically">
        <CalendarClock className="size-4" />
        Schedule
      </Button>
      <Button type="button" disabled title="Keep writing — your draft is saving automatically">
        Submit &amp; send
      </Button>
    </>
  );

  return (
    <div className="space-y-6">
      <CampaignComposer
        onAutosave={onAutosave}
        titleBadge={<Badge variant={statusVariant("draft")}>{statusLabel("draft")}</Badge>}
        titleActions={
          savedId ? (
            // After submit/schedule, land on the campaign's own page for the live
            // send/status view (composing is done, so a navigation is fine here).
            <CampaignActions
              campaignId={savedId}
              onSent={() => router.push(`/campaigns/${savedId}`)}
            />
          ) : (
            pendingActions
          )
        }
      />
    </div>
  );
}
