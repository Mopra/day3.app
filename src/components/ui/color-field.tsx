"use client";

// Shared color + slider controls used by every styling surface in the app (the
// campaign composer's StylingPanel and the signup-form Design panel). A ColorField is
// a swatch+value trigger opening a popover with the native picker, a hex field, and a
// quick palette; it only ever commits values that pass isThemeColor — the same gate
// the server re-applies — so a control can never produce a value an inline style would
// reject or that could break out of the attribute.
import { useState } from "react";
import { HexColorPicker } from "react-colorful";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { isThemeColor } from "@/lib/theme";

// Quick-pick palette shown in every color popover — neutrals, a few brand-ish
// accents, and transparent (for backgrounds/borders that should disappear).
export const COLOR_SWATCHES = [
  "#ffffff", "#f4f4f5", "#fafaf9", "#111827", "#1a1a1a", "#2563eb",
  "#7c3aed", "#db2777", "#16a34a", "#ea580c", "#e5e7eb", "transparent",
];

// Renders a swatch's fill — a checkerboard for "transparent" so it reads as "no fill"
// rather than white.
export function swatchStyle(color: string): React.CSSProperties {
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

export function ColorField({
  label,
  value,
  onChange,
  swatches = COLOR_SWATCHES,
}: {
  label: string;
  value: string;
  onChange: (color: string) => void;
  swatches?: string[];
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
            {swatches.map((c) => (
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

// A labeled px slider (roundness, border width).
export function SliderField({
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
