import { Info } from "lucide-react";

// Day3 is currently in "preview mode": Amazon SES is still in the sandbox, so we
// can verify identities and send *test* emails, but real campaign sends are
// blocked until AWS grants production access. This banner makes that limitation
// visible app-wide so users aren't surprised when a campaign can't be sent.
//
// Gated by NEXT_PUBLIC_PREVIEW_MODE (a public, build-inlined env var). The whole
// product is in preview today, so it defaults ON — set NEXT_PUBLIC_PREVIEW_MODE
// to "false" (or "off"/"0") once SES production access is approved to hide it.
export function isPreviewMode(): boolean {
  const raw = process.env.NEXT_PUBLIC_PREVIEW_MODE?.trim().toLowerCase();
  return raw !== "false" && raw !== "off" && raw !== "0";
}

export function PreviewBanner() {
  if (!isPreviewMode()) return null;
  return (
    <div
      role="status"
      className="flex items-center justify-center gap-2 border-b border-amber-200 bg-amber-50 px-4 py-1.5 text-center text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200"
    >
      <Info className="size-3.5 shrink-0" />
      <span>
        <span className="font-medium">Preview mode</span> — Day3 is awaiting Amazon
        SES production approval. You can set everything up and send test emails, but
        campaign sending stays disabled until we&apos;re approved.
      </span>
    </div>
  );
}
