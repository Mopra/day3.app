"use client";

import type * as React from "react";
import { cn } from "@/lib/utils";

// The rate-vs-threshold visual language shared by the Metrics page and the admin
// overview: a bar that fills toward a limit, coloured by how the enforcement rule
// judges the number. Kept in one place so the per-tenant Reputation card and the
// account-wide SES card read as the same instrument.

export type Tone = "good" | "warn" | "bad" | "neutral";

export const TONE_BAR: Record<Tone, string> = {
  good: "bg-olive",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  neutral: "bg-foreground/30",
};

export const TONE_DOT: Record<Tone, string> = {
  good: "bg-olive",
  warn: "bg-amber-500",
  bad: "bg-destructive",
  neutral: "bg-muted-foreground/40",
};

export const TONE_TEXT: Record<Tone, string> = {
  good: "",
  warn: "text-amber-600",
  bad: "text-destructive",
  neutral: "",
};

export function StatusPill({ tone, label }: { tone: Tone; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-medium">
      <span className={cn("size-2 rounded-full", TONE_DOT[tone])} aria-hidden />
      {label}
    </span>
  );
}

export function Bar({
  label,
  width,
  tone,
  right,
}: {
  label: React.ReactNode;
  width: number;
  tone: Tone;
  right: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-medium tabular-nums">{right}</span>
      </div>
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", TONE_BAR[tone])}
          style={{ width: `${Math.min(100, Math.max(width * 100, 0))}%` }}
        />
      </div>
    </div>
  );
}
