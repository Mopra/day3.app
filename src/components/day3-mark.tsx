import { cn } from "@/lib/utils";

// The Day3 mark, drawn inline instead of loaded as an <img>, so the three
// squares are real elements the stylesheet can reach. That is the whole point:
// the mark is the name said in shapes, two neutral squares and then the caramel
// one, and on hover the shell plays that count left to right (`.d3-mark-link`
// in globals.css). An external SVG cannot do that; nothing inside it is
// selectable.
//
// The fills are the literal values from public/day3-mark-light.svg, the only
// variant the app chrome ever used (surfaces here are dark-only), so the
// resting mark is unchanged. That file stays for everything outside the app.
export function Day3Mark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 356 100"
      width={46}
      height={13}
      role="img"
      aria-label="Day3"
      className={cn("d3-mark", className)}
    >
      <rect className="d3-mark-sq" width="100" height="100" rx="14" fill="#F6F0E3" />
      <rect className="d3-mark-sq" x="128" width="100" height="100" rx="14" fill="#F6F0E3" />
      <rect className="d3-mark-sq d3-mark-sq-accent" x="256" width="100" height="100" rx="14" fill="#D89E5C" />
    </svg>
  );
}
