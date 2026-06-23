import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * Brand loading animation: three squares orbiting a shared center, the third
 * tinted with the brand accent. Colors are theme tokens (foreground + primary)
 * so it stays visible in both light and dark modes. The motion is disabled
 * under `prefers-reduced-motion` (see `.d3-orbit` in globals.css), leaving a
 * static three-square mark.
 *
 * Use inline (next to button text, inside status pills) or, for whole-view
 * loading gates, via `OrbitLoaderScreen`.
 */
export function OrbitLoader({
  size = 120,
  className,
  label = "Loading",
}: {
  /** Outer diameter in px. Squares scale from this. */
  size?: number;
  className?: string;
  /** Accessible label, announced to screen readers. */
  label?: string;
}) {
  return (
    <span
      className={cn("d3-orbit", className)}
      role="status"
      aria-label={label}
      style={{ "--d3-size": `${size}px` } as CSSProperties}
    >
      <i />
      <i />
      <i />
    </span>
  );
}

/** Centered full-area loader for page/section loading gates. */
export function OrbitLoaderScreen({
  size = 96,
  className,
  label,
}: {
  size?: number;
  className?: string;
  label?: string;
}) {
  return (
    <div className={cn("flex min-h-[40vh] w-full items-center justify-center", className)}>
      <OrbitLoader size={size} label={label} />
    </div>
  );
}
