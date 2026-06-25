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
import { useRef, useState } from "react";
import { HexColorPicker } from "react-colorful";
import { GripVertical, Palette, RotateCcw } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import {
  DEFAULT_THEME,
  MAX_BORDER_WIDTH,
  MAX_RADIUS,
  isThemeColor,
  type CampaignTheme,
} from "@/lib/theme";

// Quick-pick palette shown in every color popover — neutrals, a few brand-ish
// accents, and transparent (for backgrounds/borders that should disappear).
const SWATCHES = [
  "#ffffff", "#f4f4f5", "#fafaf9", "#111827", "#1a1a1a", "#2563eb",
  "#7c3aed", "#db2777", "#16a34a", "#ea580c", "#e5e7eb", "transparent",
];

// Renders a swatch's fill — a checkerboard for "transparent" so it reads as "no
// fill" rather than white.
function swatchStyle(color: string): React.CSSProperties {
  if (color === "transparent") {
    return {
      backgroundImage:
        "linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%),linear-gradient(45deg,#ccc 25%,transparent 25%,transparent 75%,#ccc 75%)",
      backgroundSize: "8px 8px",
      backgroundPosition: "0 0,4px 4px",
    };
  }
  return { backgroundColor: color };
}

// A single labeled color control: a swatch+value trigger opening a popover with the
// native picker, a hex field, and the quick palette. Only commits valid colors.
function ColorField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
}) {
  // The hex text field is locally editable so a half-typed value (e.g. "#2") doesn't
  // get rejected mid-keystroke; it commits once it parses as a real color.
  const [draft, setDraft] = useState(value);
  // react-colorful's HexColorPicker only understands #rrggbb — fall back to white for
  // the picker position when the value is transparent/named, without changing the value.
  const pickerValue = /^#[0-9a-f]{6}$/i.test(value) ? value : "#ffffff";

  return (
    <div className="flex items-center justify-between gap-2">
      <span className="text-sm text-muted-foreground">{label}</span>
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              aria-label={`${label}: ${value}`}
              className="flex items-center gap-2 rounded-md border border-border px-2 py-1 transition-colors hover:bg-muted"
            />
          }
        >
          <span
            className="size-4 rounded-sm border border-foreground/10"
            style={swatchStyle(value)}
          />
          <span className="font-mono text-xs tabular-nums text-foreground">{value}</span>
        </PopoverTrigger>
        <PopoverContent side="left" align="start" className="w-56 space-y-3">
          <HexColorPicker
            color={pickerValue}
            onChange={(c) => {
              setDraft(c);
              onChange(c);
            }}
            aria-label={`${label} picker`}
          />
          <div className="flex items-center gap-2">
            <span
              className="size-9 shrink-0 rounded-md border border-border"
              style={swatchStyle(value)}
            />
            <Input
              aria-label={`${label} hex`}
              value={draft}
              onChange={(e) => {
                const next = e.target.value;
                setDraft(next);
                if (isThemeColor(next)) onChange(next.trim());
              }}
              onBlur={() => setDraft(value)}
              placeholder="#2563eb"
              className="h-9 font-mono text-xs"
            />
          </div>
          <div className="flex flex-wrap gap-1.5">
            {SWATCHES.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                title={c}
                onClick={() => {
                  setDraft(c);
                  onChange(c);
                }}
                style={swatchStyle(c)}
                className={cn(
                  "size-6 rounded-md border border-foreground/10 transition-transform hover:scale-110",
                  value === c && "ring-2 ring-foreground/40 ring-offset-1 ring-offset-popover",
                )}
              />
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}

// A labeled px slider (image/section roundness, border width).
function SliderField({
  label,
  value,
  onChange,
  min = 0,
  max,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max: number;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">{label}</span>
        <span className="w-10 text-right text-xs tabular-nums text-muted-foreground">
          {value}px
        </span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        aria-label={label}
        className="w-full accent-primary"
      />
    </div>
  );
}

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
