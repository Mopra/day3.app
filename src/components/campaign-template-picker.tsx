"use client";

// The "start from a template" gallery. A peer to the AI draft panel, not a step in
// front of the canvas: the composer still opens straight onto a writable email, and
// this appears above it (automatically for a brand-new draft, on demand afterwards).
//
// Each card's thumbnail is DERIVED, never hand-drawn — it renders the template's real
// serialized body through the same sanitizeHtml + wrapEmailDocument the send pipeline
// uses, in an inert iframe scaled down to card size. So a thumbnail cannot drift from
// the template it advertises: change the template and the picture changes with it.
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { serializeSections } from "@/lib/sections";
import { resolveTheme } from "@/lib/theme";
import { sanitizeHtml, wrapEmailDocument } from "@/services/render";
import { CAMPAIGN_TEMPLATES, type CampaignTemplate } from "@/lib/campaign-templates";

// The width wrapEmailDocument's page occupies: the 600px content card plus its 24px
// page padding on each side (see services/render.ts). Thumbnails render at this width
// and are scaled down, so the miniature has the same proportions as the real email.
const EMAIL_DOC_WIDTH = 648;
// Thumbnail boxes are 5:6, so the unscaled iframe height is a constant
// (EMAIL_DOC_WIDTH * 6 / 5) regardless of how wide the card ends up — the scale
// factor cancels out. Enough vertical room to show the top of any template.
const THUMB_DOC_HEIGHT = Math.round((EMAIL_DOC_WIDTH * 6) / 5);

// The template rendered exactly as it would ship. Built once per template.
function templateDoc(template: CampaignTemplate): string {
  const body = sanitizeHtml(serializeSections(template.build()));
  return wrapEmailDocument(body, resolveTheme(template.theme));
}

export function CampaignTemplatePicker({
  onPick,
  onClose,
}: {
  // The composer decides what applying means (and whether to confirm first).
  onPick: (template: CampaignTemplate) => void;
  onClose: () => void;
}) {
  const docs = useMemo(
    () => new Map(CAMPAIGN_TEMPLATES.map((t) => [t.key, templateDoc(t)] as const)),
    [],
  );

  // All cards share a grid column width, so one measurement scales every thumbnail.
  // Measured rather than assumed so the miniature always fills its box exactly — no
  // clipped edge and no gap between the thumbnail and its frame.
  const gridRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);
  useLayoutEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const measure = () => {
      const box = grid.querySelector("[data-thumb]");
      const width = box?.getBoundingClientRect().width ?? 0;
      if (width > 0) setScale(width / EMAIL_DOC_WIDTH);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(grid);
    return () => observer.disconnect();
  }, []);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="space-y-1">
          <CardTitle className="text-base">Start from a template</CardTitle>
          <p className="text-sm text-muted-foreground">
            A layout and a look to fill in — you can change anything afterwards.
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="-mr-1 shrink-0 self-start rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Close templates"
        >
          <X className="size-4" />
        </button>
      </CardHeader>
      <CardContent>
        <div ref={gridRef} className="grid grid-cols-2 gap-3 sm:grid-cols-3">
          {CAMPAIGN_TEMPLATES.map((template) => (
            <button
              key={template.key}
              type="button"
              onClick={() => onPick(template)}
              className="group flex flex-col gap-2 rounded-lg border border-border p-2 text-left transition-colors hover:border-primary/50 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {/* The derived miniature. The iframe is inert (sandboxed, no scripts in
                  the document anyway) and non-interactive so clicks reach the card. */}
              <div
                data-thumb
                className="relative aspect-[5/6] overflow-hidden rounded-md border border-border bg-white"
              >
                {scale > 0 && (
                  <iframe
                    title={`${template.name} preview`}
                    aria-hidden
                    tabIndex={-1}
                    sandbox=""
                    loading="lazy"
                    srcDoc={docs.get(template.key)}
                    className="pointer-events-none absolute left-0 top-0 border-0"
                    style={{
                      width: EMAIL_DOC_WIDTH,
                      height: THUMB_DOC_HEIGHT,
                      transform: `scale(${scale})`,
                      transformOrigin: "top left",
                    }}
                  />
                )}
              </div>
              <div className="space-y-0.5">
                <div className="text-sm font-medium leading-tight">{template.name}</div>
                <p className="text-xs leading-snug text-muted-foreground">{template.description}</p>
                {/* A thumbnail shows the template as it stands — an empty image slot
                    contributes nothing — so this line is what reveals the layout also
                    has a spot waiting for their upload. */}
                <p className="pt-0.5 text-[11px] leading-snug text-muted-foreground/70">
                  {template.structure}
                </p>
              </div>
            </button>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
