"use client";

import { useEffect, useMemo, useRef } from "react";
import { ArrowLeft, Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { CampaignComposer, type CampaignFormValues } from "@/components/campaign-composer";
import { useApi } from "@/lib/api";
import { SendNodeConfigSchema, nodeTitle, type SendNodeConfig } from "@/lib/automation-graph";
import type { AutomationDetail, GraphPayloadNode } from "@/lib/automation-types";
import { safeParseSections } from "@/lib/sections";
import { resolveTheme } from "@/lib/theme";
import { DEFAULT_FOOTER_TEXT } from "@/services/render";

// The full composer, as a page-sized overlay, editing one send node. The node's
// message fields live in its config; the From identity, footer and theme are the
// automation's, so a theme change made here is saved to the automation (it
// applies to every email in the flow) and the footer is read-only.
export function SendNodeEditor({
  node,
  detail,
  onSaveConfig,
  onDetailChange,
  onClose,
}: {
  node: GraphPayloadNode;
  detail: AutomationDetail;
  onSaveConfig: (config: SendNodeConfig) => void;
  onDetailChange: (detail: AutomationDetail) => void;
  onClose: () => void;
}) {
  const api = useApi();

  // Latest node/detail for the autosave callback, which the composer holds
  // across renders.
  const nodeRef = useRef(node);
  const detailRef = useRef(detail);
  useEffect(() => {
    nodeRef.current = node;
    detailRef.current = detail;
  }, [node, detail]);

  // Seed once: the composer reads its defaults on mount only.
  const initialValues = useMemo<Partial<CampaignFormValues>>(() => {
    const parsed = SendNodeConfigSchema.safeParse(node.config ?? {});
    const cfg = parsed.success ? parsed.data : null;
    return {
      name: nodeTitle(node),
      subject: cfg?.subject ?? "",
      previewText: cfg?.previewText ?? "",
      sections: safeParseSections(cfg?.sectionsJson) ?? undefined,
      htmlBody: cfg?.htmlBody ?? "",
      textBody: cfg?.textBody ?? "",
      footerText: detail.footerText ?? DEFAULT_FOOTER_TEXT,
      theme: resolveTheme(detail.theme),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [node.key]);

  // The page behind the overlay must not scroll along with it, and keyboard
  // focus moves into the overlay on open so the next Tab lands in the composer
  // rather than on the canvas underneath.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    root.current?.focus();
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  async function onAutosave(values: CampaignFormValues) {
    const current = SendNodeConfigSchema.safeParse(nodeRef.current.config ?? {});
    const base: SendNodeConfig = current.success
      ? current.data
      : {
          subject: "",
          previewText: null,
          sectionsJson: null,
          htmlBody: "",
          textBody: null,
          allowResend: false,
        };
    const next: SendNodeConfig = {
      ...base,
      subject: values.subject,
      previewText: values.previewText?.trim() || null,
      sectionsJson: values.sections ? JSON.stringify(values.sections) : null,
      htmlBody: values.htmlBody,
      textBody: values.textBody?.trim() || null,
    };
    // The composer's watcher also fires on its own smart defaults (sender
    // auto-select), so only a real content change reaches the draft.
    if (JSON.stringify(next) !== JSON.stringify(base)) onSaveConfig(next);

    const theme = resolveTheme(values.theme);
    const currentTheme = resolveTheme(detailRef.current.theme);
    if (JSON.stringify(theme) !== JSON.stringify(currentTheme)) {
      try {
        const updated = await api.patch<AutomationDetail>(`/api/automations/${detailRef.current.id}`, {
          theme,
        });
        onDetailChange(updated);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Couldn't save the styling");
        throw err;
      }
    }
  }

  return (
    // `nokey`: React Flow must not read a Backspace in the composer as "delete
    // the selected node" (the canvas also drops its delete keys while this is
    // open; the class covers focused buttons the input check does not).
    <div
      ref={root}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={`Edit ${nodeTitle(node)}`}
      className="nokey fixed inset-0 z-50 overflow-y-auto bg-background outline-none"
    >
      <div className="sticky top-0 z-10 flex h-12 items-center gap-3 border-b border-border bg-background/95 px-4 backdrop-blur supports-backdrop-filter:bg-background/80">
        <Button variant="ghost" size="sm" onClick={onClose}>
          <ArrowLeft />
          Back to canvas
        </Button>
        <span className="min-w-0 truncate text-sm text-muted-foreground">
          {detail.name}
        </span>
      </div>
      <div className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-6">
        <CampaignComposer
          variant="automation-node"
          initialValues={initialValues}
          onAutosave={onAutosave}
          titleActions={
            <Button size="sm" onClick={onClose}>
              <Check />
              Done
            </Button>
          }
        />
      </div>
    </div>
  );
}
