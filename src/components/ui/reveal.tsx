import * as React from "react";

import { cn } from "@/lib/utils";

type RevealProps = React.ComponentProps<"div"> & {
  /** Delay before the transition starts, in ms — used to stagger siblings. */
  delay?: number;
};

/**
 * Fades and lifts its children in as the page paints.
 *
 * The animation is pure CSS (`.reveal` in globals.css): it runs from the server
 * HTML, so nothing waits on hydration. It used to start invisible and wait for
 * an IntersectionObserver to flip `is-visible` after JavaScript loaded, which
 * made the dashboard blank on first paint for up to a second. Reduced-motion is
 * handled in CSS.
 *
 * Reach for it on pages whose content is a short stack of *sections* (the
 * dashboard, metrics) and stagger with `delay` so the page assembles itself
 * once. Keep delays small: every millisecond of it is content the user can see
 * but not yet read. Deliberately not used on the list and table pages: a row
 * that fades in is a row you can't click yet.
 *
 * Wrap the container, not each child. Wrapping siblings individually makes each
 * Reveal the flex/grid item, which quietly breaks equal-height rows (the
 * dashboard's three stat cards are meant to align as one set).
 */
function Reveal({ className, delay = 0, style, children, ...props }: RevealProps) {
  return (
    <div
      className={cn("reveal", className)}
      style={{ ...style, "--reveal-delay": `${delay}ms` } as React.CSSProperties}
      {...props}
    >
      {children}
    </div>
  );
}

export { Reveal };
