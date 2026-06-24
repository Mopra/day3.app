"use client";

import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  firstSendingPlan,
  isPlanKey,
  nextPlanUp,
  planCanSend,
  planLabel,
  planMeta,
  type PlanKey,
} from "@/lib/plans-catalog";
import type { Account } from "@/lib/types";

export type UsageState = "ok" | "warning" | "over";

export type UsageInfo = {
  used: number;
  limit: number;
  /** 0–100, clamped. */
  pct: number;
  /** Raw used/limit ratio (can exceed 1). */
  ratio: number;
  state: UsageState;
  /** The current plan key, or null for an unrecognized/legacy value. */
  plan: PlanKey | null;
  /** The next tier up to upgrade into, or null when already on the top tier. */
  next: PlanKey | null;
};

// Derives everything the usage UI needs from an account row. The 80% / 100%
// thresholds drive the amber "running low" nudge and the red "limit reached"
// state respectively.
export function usageInfo(account: Account): UsageInfo {
  const used = account.monthlyEmailSentCount;
  const limit = account.monthlyEmailLimit || 0;
  const ratio = limit > 0 ? used / limit : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  const state: UsageState = ratio >= 1 ? "over" : ratio >= 0.8 ? "warning" : "ok";
  const plan = isPlanKey(account.plan) ? account.plan : null;
  const next = plan ? nextPlanUp(plan) : null;
  return { used, limit, pct, ratio, state, plan, next };
}

const BAR_COLOR: Record<UsageState, string> = {
  ok: "bg-primary",
  warning: "bg-amber-500",
  over: "bg-destructive",
};

// A usage progress bar that recolors as the account approaches its cap. Standalone
// so the dashboard card and the billing page render an identical meter.
export function UsageBar({ info, className }: { info: UsageInfo; className?: string }) {
  return (
    <div
      className={cn("bg-muted relative h-2 w-full overflow-hidden rounded-full", className)}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={info.pct}
    >
      <div
        className={cn("h-full rounded-full transition-all", BAR_COLOR[info.state])}
        style={{ width: `${info.pct}%` }}
      />
    </div>
  );
}

type NudgeTone = "info" | "warning" | "over";

const NUDGE_TONE: Record<NudgeTone, { box: string; icon: string }> = {
  info: { box: "border-primary/40 bg-primary/5", icon: "text-primary" },
  warning: { box: "border-amber-500/40 bg-amber-500/5", icon: "text-amber-600" },
  over: { box: "border-destructive/40 bg-destructive/5", icon: "text-destructive" },
};

function NudgeCard({
  tone,
  headline,
  body,
  cta,
  primary,
}: {
  tone: NudgeTone;
  headline: string;
  body: string;
  cta: string;
  primary: boolean;
}) {
  const t = NUDGE_TONE[tone];
  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between",
        t.box,
      )}
    >
      <div className="flex items-start gap-3">
        <Sparkles className={cn("mt-0.5 h-5 w-5 shrink-0", t.icon)} aria-hidden />
        <div className="space-y-0.5">
          <p className="text-sm font-medium">{headline}</p>
          <p className="text-sm text-muted-foreground">{body}</p>
        </div>
      </div>
      <Button
        size="sm"
        variant={primary ? "default" : "outline"}
        className="shrink-0"
        render={
          <Link href="/billing">
            {cta}
            <ArrowUpRight className="ml-1 h-4 w-4" />
          </Link>
        }
      />
    </div>
  );
}

// The contextual upgrade prompt. Two cases:
//   - Free / non-sending tier → a persistent "subscribe to start sending" prompt
//     (this is the primary conversion path; the free tier can set up + draft but
//     never send).
//   - Paid tier nearing/over the monthly cap → a "next tier up" prompt.
// Renders nothing when a paid account is comfortably within its allowance, or is
// already on the top tier.
export function UpgradeNudge({ account }: { account: Account }) {
  if (!planCanSend(account.plan)) {
    const target = planMeta(firstSendingPlan());
    return (
      <NudgeCard
        tone="info"
        primary
        headline="You're on the Free plan"
        body={`Set up domains, audiences and drafts for free. Subscribe to a paid plan (from $${target.monthlyPriceUsd}/mo) to start sending.`}
        cta="Choose a plan"
      />
    );
  }

  const info = usageInfo(account);
  if (info.state === "ok" || !info.next) return null;

  const next = planMeta(info.next);
  const over = info.state === "over";
  return (
    <NudgeCard
      tone={over ? "over" : "warning"}
      primary={over}
      headline={over ? "You've hit your monthly send limit" : `You've used ${info.pct}% of your monthly emails`}
      body={
        over
          ? `Upgrade to the ${next.name} plan to keep sending — ${next.monthlyEmailLimit.toLocaleString()} emails/mo for $${next.monthlyPriceUsd}.`
          : `Upgrade to the ${next.name} plan for ${next.monthlyEmailLimit.toLocaleString()} emails/mo ($${next.monthlyPriceUsd}) and never get blocked mid-send.`
      }
      cta="Upgrade plan"
    />
  );
}

// A one-line usage summary ("3,200 / 5,000 emails this period") with the meter.
// Used on the dashboard and billing current-plan cards. The free (non-sending)
// tier has no allowance to meter, so it shows a setup-only message instead.
export function UsageSummary({ account }: { account: Account }) {
  if (!planCanSend(account.plan)) {
    return (
      <p className="text-sm text-muted-foreground">
        The Free plan can&apos;t send email — subscribe to a paid plan to unlock sending.
      </p>
    );
  }
  const info = usageInfo(account);
  const remaining = Math.max(0, info.limit - info.used);
  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2 text-sm">
        <span className="font-medium tabular-nums">
          {info.used.toLocaleString()}
          <span className="font-normal text-muted-foreground">
            {" "}
            / {info.limit.toLocaleString()}
          </span>
        </span>
        <span className="text-xs text-muted-foreground">
          {info.state === "over"
            ? "Limit reached"
            : `${remaining.toLocaleString()} left on ${planLabel(account.plan)}`}
        </span>
      </div>
      <UsageBar info={info} />
    </div>
  );
}
