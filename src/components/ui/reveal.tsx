"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

type RevealProps = React.ComponentProps<"div"> & {
  /** Delay before the transition starts, in ms — used to stagger siblings. */
  delay?: number;
};

/**
 * Fades and lifts its children the first time they scroll into view.
 *
 * Ported from the marketing site, where it gives the page its unhurried feel.
 * The transition itself is pure CSS (`.reveal` in globals.css, on the same
 * cubic-bezier the site uses); this only flips `is-visible` via an
 * IntersectionObserver, then disconnects. Reduced-motion is handled in CSS,
 * which pins `.reveal` fully visible, and where IO is unavailable it degrades
 * to visible on the next frame rather than staying blank.
 *
 * Reach for it on pages whose content is a short stack of *sections* — the
 * dashboard, metrics — and stagger with `delay` so the page assembles itself
 * once. Deliberately not used on the list and table pages: a row that fades in
 * is a row you can't click yet, and there is nothing atmospheric about waiting
 * for a table.
 *
 * Wrap the container, not each child. Wrapping siblings individually makes each
 * Reveal the flex/grid item, which quietly breaks equal-height rows (the
 * dashboard's three stat cards are meant to align as one set).
 */
function Reveal({ className, delay = 0, style, children, ...props }: RevealProps) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    const node = ref.current;
    if (!node) return;

    if (typeof IntersectionObserver === "undefined") {
      const frame = requestAnimationFrame(() => setVisible(true));
      return () => cancelAnimationFrame(frame);
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setVisible(true);
            observer.disconnect();
            break;
          }
        }
      },
      { threshold: 0.1, rootMargin: "0px 0px -6% 0px" },
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className={cn("reveal", visible && "is-visible", className)}
      style={{ ...style, "--reveal-delay": `${delay}ms` } as React.CSSProperties}
      {...props}
    >
      {children}
    </div>
  );
}

export { Reveal };
