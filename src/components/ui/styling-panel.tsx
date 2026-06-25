"use client";

// The campaign builder's global styling panel. Sits docked to the right of the
// message column and edits the campaign's CampaignTheme (see lib/theme.ts): the
// email-wide page/content background, text/heading/link colors, border, and corner
// roundness. Controlled exactly like the rest of the composer — `value` is the full
// resolved theme, `onChange` fires with the next theme on any edit (the composer then
// autosaves and re-themes the live canvas + preview).
//
// Every color committed here passes isThemeColor (a hex/rgb/named token), the same
// gate the server re-applies — so the panel can never produce a value the email
// document would reject or that could break out of an inline style.
import { useRef } from "react";
import { GripVertical, Palette, RotateCcw } from "lucide-react";
import { cn } from "@/lib/utils";
import { ColorField, SliderField } from "@/components/ui/color-field";
import {
  DEFAULT_THEME,
  MAX_BORDER_WIDTH,
  MAX_RADIUS,
  type CampaignTheme,
} from "@/lib/theme";

// A small titled group of controls inside the panel.
function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2.5">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground/70">
        {title}
      </h4>
      {children}
    </div>
  );
}

export function StylingPanel({
  value,
  onChange,
}: {
  value: CampaignTheme;
  onChange: (theme: CampaignTheme) => void;
}) {
  const set = (patch: Partial<CampaignTheme>) => onChange({ ...value, ...patch });
  const isDefault =
    JSON.stringify(value) === JSON.stringify(DEFAULT_THEME);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
          <Palette className="size-4 text-muted-foreground" />
          Styling
        </h3>
        <button
          type="button"
          onClick={() => onChange({ ...DEFAULT_THEME })}
          disabled={isDefault}
          className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <RotateCcw className="size-3" />
          Reset
        </button>
      </div>

      <Group title="Background">
        <ColorField label="Page" value={value.pageBg} onChange={(c) => set({ pageBg: c })} />
        <ColorField
          label="Sections"
          value={value.contentBg}
          onChange={(c) => set({ contentBg: c })}
        />
        <SliderField
          label="Section roundness"
          value={value.sectionRadius}
          onChange={(v) => set({ sectionRadius: v })}
          max={MAX_RADIUS}
        />
      </Group>

      <Group title="Text">
        <ColorField label="Body" value={value.textColor} onChange={(c) => set({ textColor: c })} />
        <ColorField
          label="Headings"
          value={value.headingColor}
          onChange={(c) => set({ headingColor: c })}
        />
        <ColorField label="Links" value={value.linkColor} onChange={(c) => set({ linkColor: c })} />
      </Group>

      <Group title="Border">
        <ColorField
          label="Color"
          value={value.borderColor}
          onChange={(c) => set({ borderColor: c })}
        />
        <SliderField
          label="Width"
          value={value.borderWidth}
          onChange={(v) => set({ borderWidth: v })}
          max={MAX_BORDER_WIDTH}
        />
      </Group>

      <Group title="Images">
        <SliderField
          label="Roundness"
          value={value.imageRadius}
          onChange={(v) => set({ imageRadius: v })}
          max={MAX_RADIUS}
        />
      </Group>
    </div>
  );
}

// The styling panel as a floating drawer appended to the right edge of the composer
// content (not the screen). The host element must be `position: relative`; this fills
// its height (`inset-y-0 right-0`) and stays vertically centered in view via a sticky
// inner wrapper. A slim vertical grip is the handle: tap to toggle, or drag it left to
// open / right to collapse. The panel expands *inward* over the content — its width
// animates from 0 to its full size — so it never pushes past the content's right edge
// into a horizontal scrollbar.
export function FloatingStylingPanel({
  value,
  onChange,
  open,
  onOpenChange,
}: {
  value: CampaignTheme;
  onChange: (theme: CampaignTheme) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Pointer drag bookkeeping: where the press started and whether it moved enough to
  // count as a drag (so a stationary press falls through to a click-toggle on release).
  const drag = useRef<{ x: number; moved: boolean } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    if (Math.abs(dx) > 6) d.moved = true;
    // Drag left past the threshold opens; drag right collapses.
    if (dx < -28 && !open) onOpenChange(true);
    if (dx > 28 && open) onOpenChange(false);
  };
  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    // A press that never really moved is a click — toggle.
    if (d && !d.moved) onOpenChange(!open);
  };

  return (
    // Full-height layer pinned to the content's right edge; lets clicks through except
    // on the handle/panel themselves. The negative right offset cancels the content
    // card's horizontal padding (app-shell <main> uses px-8) so the drawer sits flush
    // against the card's inner edge rather than inset by the padding.
    <div className="pointer-events-none absolute inset-y-0 -right-8 z-40">
      <div className="pointer-events-auto sticky top-1/2 flex -translate-y-1/2 items-stretch justify-end">
        {/* Grip — the draggable handle on the panel's inner side. When collapsed it's
            the only thing showing, a small tab flush to the content edge. */}
        <button
          type="button"
          aria-label={open ? "Collapse styling panel" : "Expand styling panel"}
          aria-expanded={open}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="mr-1 flex h-28 w-7 shrink-0 cursor-grab touch-none items-center justify-center self-center rounded-full border border-border bg-muted text-muted-foreground shadow-md transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </button>

        {/* Width-animated clip: reveals the fixed-width panel by growing inward from
            the grip. The inner body keeps its full width so its layout never reflows. */}
        <div
          className={cn(
            "overflow-hidden transition-[width] duration-300 ease-out",
            open ? "w-72" : "w-0",
          )}
        >
          <div className="max-h-[80vh] w-72 overflow-y-auto rounded-l-xl border border-r-0 border-border bg-card p-5 shadow-xl">
            <StylingPanel value={value} onChange={onChange} />
          </div>
        </div>
      </div>
    </div>
  );
}
