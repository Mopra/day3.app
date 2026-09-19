import { ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/utils";
import type { HelpLink } from "@/lib/docs-links";

// The two ways the app links out to written help. Both live here so every docs
// link in the product looks and behaves the same — external, new tab, with the
// same arrow — rather than each surface inventing its own.
//
// Which link goes where is not decided here: `src/lib/docs-links.ts` owns the
// route→help map and the URLs. These are only the renderers.

/**
 * A full row: title, one line of "what this answers", hover affordance. Used
 * wherever there is room for a short list — the Help popover, the API panel.
 * The blurb is load-bearing: a bare list of reference page titles
 * ("Conventions", "Topics") reads as jargon to anyone who hasn't read them.
 */
export function DocsLinkRow({ link, className }: { link: HelpLink; className?: string }) {
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        "group flex items-start gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted",
        className,
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1 text-sm font-medium">
          {link.label}
          <ArrowUpRight className="size-3 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </span>
        <span className="mt-0.5 block text-xs leading-snug text-muted-foreground">
          {link.blurb}
        </span>
      </span>
    </a>
  );
}

/**
 * A quiet inline link, for putting beside a heading or at the end of a
 * paragraph where a full row would shout. `label` overrides the link's own
 * text when the surrounding sentence needs something shorter.
 */
export function DocsInlineLink({
  link,
  label,
  className,
}: {
  link: HelpLink;
  label?: string;
  className?: string;
}) {
  return (
    <a
      href={link.href}
      target="_blank"
      rel="noopener noreferrer"
      title={link.blurb}
      className={cn(
        "inline-flex items-center gap-0.5 text-muted-foreground underline decoration-border underline-offset-4 transition-colors hover:text-foreground hover:decoration-current",
        className,
      )}
    >
      {label ?? link.label}
      <ArrowUpRight className="size-3 shrink-0" />
    </a>
  );
}
