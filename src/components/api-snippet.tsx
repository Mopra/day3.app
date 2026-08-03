"use client";

import { CopyButton } from "@/components/copy-button";

// Shared chrome for developer-facing copyables — used by the /api-keys docs
// page and the per-resource API panel. Content comes from src/lib/api-docs.ts;
// these are only the frames.

export function Snippet({ code, tall }: { code: string; tall?: boolean }) {
  return (
    <pre
      className={`overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed ${
        tall ? "max-h-96" : "max-h-72"
      }`}
    >
      <code>{code}</code>
    </pre>
  );
}

// A copyable one-liner: monospace value on the left, copy affordance on the
// right, aligned on a single row like the DNS records on the domains page.
export function CopyLine({ value, muted }: { value: string; muted?: boolean }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2">
      <code
        className={`min-w-0 flex-1 truncate font-mono text-xs ${
          muted ? "text-muted-foreground" : ""
        }`}
      >
        {value}
      </code>
      <CopyButton value={value} variant="ghost" />
    </div>
  );
}
