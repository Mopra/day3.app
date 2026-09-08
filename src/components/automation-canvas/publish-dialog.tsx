"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { nodeTitle, type GraphIssue, type GraphValidation } from "@/lib/automation-graph";
import type { AutomationDetail, PublishFailure } from "@/lib/automation-types";

// Publishing is the one irreversible-feeling moment on this page: the draft
// becomes the version new contacts enter. So the dialog says exactly what the
// validator thinks, who is mid-flight and what happens to them, and only then
// offers the button. A 422 from the server (its validation disagrees, or a send
// node failed the risk review) lands in the same list.
function isPublishFailure(body: unknown): body is PublishFailure {
  return (
    typeof body === "object" &&
    body !== null &&
    "validation" in body &&
    typeof (body as PublishFailure).error === "string"
  );
}

export function PublishDialog({
  open,
  onOpenChange,
  detail,
  serverValidation,
  onPublished,
  onFailure,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: AutomationDetail;
  // The verdict from the last failed publish, held by the page until the graph
  // changes. Shown again on reopen so a gate the canvas cannot draw (no From
  // address, no mailing address) is not forgotten the moment the dialog closes.
  serverValidation: GraphValidation | null;
  onPublished: (detail: AutomationDetail) => void;
  // Called with the offending node keys so the canvas can put them in view.
  onFailure: (validation: GraphValidation) => void;
}) {
  const [failure, setFailure] = useState<PublishFailure | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setFailure(null);
  }, [open]);

  const validation = failure?.validation ?? serverValidation ?? detail.validation;
  const live = detail.liveVersion;
  const inFlight = detail.counts.active + detail.counts.sending;
  const nextVersion = (live?.version ?? 0) + 1;

  function describe(issue: GraphIssue): string {
    // Validation messages already carry the node's title; a node-less issue
    // stands on its own.
    if (!issue.nodeKey) return issue.message;
    const node = detail.draft.nodes.find((n) => n.key === issue.nodeKey);
    return node && !issue.message.includes(nodeTitle(node))
      ? `${nodeTitle(node)}: ${issue.message}`
      : issue.message;
  }

  async function publish() {
    setBusy(true);
    try {
      // Raw fetch rather than useApi: a 422 carries the validation we want to
      // show, and the shared helper keeps only the error string.
      const res = await fetch(`/api/automations/${detail.id}/publish`, { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as
        | AutomationDetail
        | PublishFailure
        | { error?: string };
      if (res.status === 422 && isPublishFailure(body)) {
        setFailure(body);
        onFailure(body.validation);
        return;
      }
      if (!res.ok) {
        throw new Error(("error" in body && body.error) || res.statusText);
      }
      const updated = body as AutomationDetail;
      onPublished(updated);
      toast.success(`Published v${updated.liveVersion?.version ?? nextVersion}`);
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't publish");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{live ? `Publish changes as v${nextVersion}?` : "Publish this automation?"}</DialogTitle>
          <DialogDescription>
            {live
              ? "The new version takes over for everyone who enters from now on."
              : "Publishing turns the automation on: contacts who match the trigger start entering right away."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          {failure && (
            <p className="text-destructive">{failure.error}</p>
          )}

          {validation.errors.length > 0 ? (
            <div className="space-y-1.5">
              <p className="font-medium">Fix these first</p>
              <ul className="space-y-1">
                {validation.errors.map((i, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-destructive">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>{describe(i)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="flex items-center gap-2 text-muted-foreground">
              <Check className="size-4 shrink-0 text-olive" />
              The flow checks out.
            </p>
          )}

          {validation.warnings.length > 0 && (
            <div className="space-y-1.5">
              <p className="font-medium">Worth a look</p>
              <ul className="space-y-1 text-muted-foreground">
                {validation.warnings.map((i, idx) => (
                  <li key={idx} className="flex items-start gap-2">
                    <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                    <span>{describe(i)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {live && (
            <p className="rounded-lg border border-border bg-muted/40 p-3 text-muted-foreground">
              {inFlight > 0 ? (
                <>
                  <span className="font-medium text-foreground">
                    {inFlight.toLocaleString()} {inFlight === 1 ? "person is" : "people are"}
                  </span>{" "}
                  part-way through v{live.version}. They finish on that version; only people
                  who enter after you publish get v{nextVersion}.
                </>
              ) : (
                <>Nobody is mid-flight on v{live.version} right now.</>
              )}
            </p>
          )}

          {detail.sandbox && (
            <p className="text-muted-foreground">
              Sandbox mode: on the Free plan this automation only reaches members of your
              organization.
            </p>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={busy || validation.errors.length > 0} onClick={publish}>
              {busy && <OrbitLoader size={16} />}
              {live ? "Publish changes" : "Publish"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
