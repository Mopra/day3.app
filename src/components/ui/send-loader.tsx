import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * Send animations built from the Day3 three-block mark, for the campaign send
 * flow. Pure CSS (see `.d3ls` / `.d3dots` in globals.css). Colors use theme
 * tokens — foreground for the queue, primary for the flare — so they work in
 * light and dark. Motion stops under `prefers-reduced-motion`.
 */

/**
 * LaunchStream — blocks queue in from the left, flare to the accent at the
 * front, then rocket off to the right. Native size 320×56; the keyframe
 * distances are absolute, so resize the whole thing with `scale` (a transform),
 * not by setting a width.
 */
export function LaunchStream({
  scale = 1,
  className,
  label = "Sending",
}: {
  scale?: number;
  className?: string;
  label?: string;
}) {
  return (
    <div
      className={cn("shrink-0", className)}
      style={{ width: 320 * scale, height: 56 * scale }}
      role="status"
      aria-label={label}
    >
      <div className="d3ls" style={{ transform: `scale(${scale})`, transformOrigin: "top left" }}>
        <span className="d3ls__b" />
        <span className="d3ls__b" />
        <span className="d3ls__b" />
        <span className="d3ls__b" />
        <span className="d3ls__b" />
      </div>
    </div>
  );
}

/**
 * SendDots — compact three-dot feed-in / launch-out, sized to sit inline beside
 * button text. Inherits `currentColor` for the queued dots so it reads on any
 * button background; the launching dot uses the brand accent.
 */
export function SendDots({ className }: { className?: string }) {
  return (
    <span className={cn("d3dots", className)} aria-hidden="true">
      <span className="d3dots__d d3dots__d--in" style={{ left: 0 } as CSSProperties} />
      <span className="d3dots__d d3dots__d--in" style={{ left: 15, animationDelay: "-0.18s" } as CSSProperties} />
      <span className="d3dots__d d3dots__d--out" style={{ left: 30 } as CSSProperties} />
    </span>
  );
}
