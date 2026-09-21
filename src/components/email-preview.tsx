"use client";

import { cn } from "@/lib/utils";
import { sanitizeHtml, wrapEmailDocument } from "@/services/render";
import { resolveTheme } from "@/lib/theme";
import type { CampaignThemeInput } from "@/lib/theme";

/**
 * The email as it actually goes out: the saved body run through the SAME
 * sanitizeHtml + wrapEmailDocument the send pipeline uses, with the campaign's
 * own theme. A bare `srcDoc={htmlBody}` renders the body markup without the
 * wrapper, so the page/content colors, typography and 600px column are simply
 * absent and a sent campaign looks nothing like what subscribers received —
 * which is the one thing a reviewer is here to judge.
 *
 * Shared by the tenant's campaign detail page and both admin surfaces so those
 * three previews cannot drift apart.
 */
export function EmailPreview({
  htmlBody,
  theme,
  className,
  frameClassName = "h-80",
}: {
  htmlBody: string;
  theme: CampaignThemeInput | null | undefined;
  className?: string;
  frameClassName?: string;
}) {
  return (
    <div className={cn("overflow-auto rounded-lg border border-border bg-white", className)}>
      <iframe
        title="Email preview"
        sandbox=""
        srcDoc={wrapEmailDocument(sanitizeHtml(htmlBody), resolveTheme(theme))}
        className={cn("w-full border-0", frameClassName)}
      />
    </div>
  );
}
