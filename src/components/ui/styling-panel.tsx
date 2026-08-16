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

// The styling panel as a floating card near the right edge of the screen and
// vertically centered in the viewport, so it stays put as the composer scrolls.
// It floats with a small gap from the edge (rather than flush to it) so it clears
// the window's vertical scrollbar instead of sitting on top of it.
// A slim vertical grip is the handle: tap to toggle, or drag it left to
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
    // Fixed to the viewport and vertically centered on screen, floated a few px off
    // the right edge so it clears the scrollbar; lets clicks through except on the
    // handle/panel themselves. Staying fixed means the panel keeps its centered
    // position as the composer scrolls.
    <div className="pointer-events-none fixed top-1/2 right-3 z-40 -translate-y-1/2">
      <div className="pointer-events-auto flex items-stretch justify-end">
        {/* Grip — the draggable handle on the panel's inner side. When collapsed it's
            the only thing showing, a small tab flush to the content edge. */}
        <button
          type="button"
          aria-label={open ? "Collapse styling panel" : "Expand styling panel"}
          aria-expanded={open}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          className="relative z-10 mr-1 flex h-28 w-7 shrink-0 cursor-grab touch-none items-center justify-center self-center rounded-full border border-border bg-muted text-muted-foreground shadow-[0_10px_30px_-8px_rgba(0,0,0,0.6),0_4px_12px_-4px_rgba(0,0,0,0.45)] transition-colors hover:bg-accent hover:text-foreground active:cursor-grabbing"
        >
          <GripVertical className="size-4" />
        </button>

        {/* Width-animated clip: reveals the fixed-width panel by growing inward from
            the grip. The inner body keeps its full width so its layout never reflows. */}
        <div
          className={cn(
            // Clip the fixed-width card as its width animates, so the panel reveals by
            // growing inward from the grip. The drop shadow lives HERE on the clip, not
            // on the card inside it: this element's overflow-hidden would swallow the
            // card's own shadow, but it never clips its *own* box-shadow. Gated on `open`
            // so a collapsed (w-0) panel doesn't leave a shadow sliver by the grip.
            "overflow-hidden rounded-xl transition-[width] duration-300 ease-out",
            open
              ? "w-[min(18rem,calc(100vw-4rem))] shadow-[0_24px_60px_-12px_rgba(0,0,0,0.65),0_8px_24px_-8px_rgba(0,0,0,0.5)]"
              : "w-0",
          )}
        >
          {/* The inner body keeps a fixed width so its layout never reflows as
              the clip animates — but that width is capped to the viewport on a
              phone, where a flat 18rem card plus the grip runs off the screen. */}
          <div className="max-h-[80dvh] w-[min(18rem,calc(100vw-4rem))] overflow-y-auto rounded-xl border border-border bg-card p-4 sm:p-5">
            <StylingPanel value={value} onChange={onChange} />
          </div>
        </div>
      </div>
    </div>
  );
}
