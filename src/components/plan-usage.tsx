"use client";

import Link from "next/link";
import { ArrowUpRight, Sparkles } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  effectiveMonthlyLimit,
  firstSendingPlan,
  isPlanKey,
  nextPlanUp,
  planLabel,
  planMeta,
  planSandboxMode,
  SANDBOX_MONTHLY_ALLOWANCE,
  type PlanKey,
} from "@/lib/plans-catalog";
import type { Account } from "@/lib/types";
import { rampDailyLimit } from "@/services/send-ramp";

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
// state respectively. A sandbox (free) account meters the same way against the
// sandbox allowance — it has a real ceiling now, so it gets a real meter.
export function usageInfo(account: Account): UsageInfo {
  const used = account.monthlyEmailSentCount;
  const limit = effectiveMonthlyLimit(account.plan, account.monthlyEmailLimit) || 0;
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
//   - Free / sandbox tier → a persistent "subscribe to send to your real
//     audience" prompt (the primary conversion path; free can send for real, but
//     only to its own team and only on the sandbox allowance).
//   - Paid tier nearing/over the monthly cap → a "next tier up" prompt.
// Renders nothing when a paid account is comfortably within its allowance, or is
// already on the top tier.
export function UpgradeNudge({ account }: { account: Account }) {
  if (planSandboxMode(account.plan)) return <FreePlanNudge account={account} />;

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
          ? `Upgrade to the ${next.name} plan to keep sending: ${next.monthlyEmailLimit.toLocaleString()} emails/mo for $${next.monthlyPriceUsd}.`
          : `Upgrade to the ${next.name} plan for ${next.monthlyEmailLimit.toLocaleString()} emails/mo ($${next.monthlyPriceUsd}) and never get blocked mid-send.`
      }
      cta="Upgrade plan"
    />
  );
}

// The Free plan has two ceilings: the monthly test-send allowance and the stored
// subscriber cap. The cap used to be invisible until it blocked an import or,
// worse, quietly turned away signup-form visitors, so it is metered here too and
// takes over the card once the list is nearly full.
function FreePlanNudge({ account }: { account: Account }) {
  const api = useApi();
  const [subs, setSubs] = useState<{ cap: number; used: number } | null>(null);
  useEffect(() => {
    api
      .get<{ cap: number | null; used: number | null }>("/api/account/subscriber-limit")
      .then((res) => {
        if (res.cap !== null && res.used !== null) setSubs({ cap: res.cap, used: res.used });
      })
      .catch(() => {});
  }, [api]);

  const price = planMeta(firstSendingPlan()).monthlyPriceUsd;
  const left = Math.max(0, SANDBOX_MONTHLY_ALLOWANCE - account.monthlyEmailSentCount);
  const listFull = subs !== null && subs.used >= subs.cap;
  const listNearlyFull = subs !== null && !listFull && subs.used >= subs.cap * 0.8;
  const subsLine = subs
    ? ` ${subs.used.toLocaleString()} of ${subs.cap.toLocaleString()} subscribers stored.`
    : "";

  if (listFull) {
    return (
      <NudgeCard
        tone="over"
        primary
        headline="Your list is full"
        body={`The Free plan stores up to ${subs.cap.toLocaleString()} subscribers. New signups and imports are turned away until you pick a plan (from $${price}/mo, no subscriber limit).`}
        cta="Choose a plan"
      />
    );
  }
  if (left === 0) {
    return (
      <NudgeCard
        tone="over"
        primary
        headline="You've used this month's test emails"
        body={`Free accounts get ${SANDBOX_MONTHLY_ALLOWANCE} test emails a month, to your team only. Pick a plan (from $${price}/mo) to send to your real audience.${subsLine}`}
        cta="Choose a plan"
      />
    );
  }
  return (
    <NudgeCard
      tone={listNearlyFull ? "warning" : "info"}
      primary
      headline={
        listNearlyFull ? "Your list is nearly full" : "You're on the Free plan: test mode"
      }
      body={`Campaigns send for real, but only to your team. ${left} of ${SANDBOX_MONTHLY_ALLOWANCE} test emails left this month.${subsLine} Pick a plan (from $${price}/mo) to send to everyone.`}
      cta="Choose a plan"
    />
  );
}

// A one-line usage summary ("3,200 / 5,000 emails this period") with the meter.
// Used on the dashboard and billing current-plan cards. A sandbox account meters
// against the sandbox allowance and says so, rather than showing a dash — the
// number it's burning through is the whole point of the mode.
export function UsageSummary({ account }: { account: Account }) {
  const sandbox = planSandboxMode(account.plan);
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
            : sandbox
              ? `${remaining.toLocaleString()} test emails left`
              : `${remaining.toLocaleString()} left on ${planLabel(account.plan)}`}
        </span>
      </div>
      <UsageBar info={info} />
      {sandbox && (
        <p className="text-xs text-muted-foreground">
          Test sends go to your own team only.
        </p>
      )}
      {!sandbox && <RampNote account={account} />}
    </div>
  );
}

// The new-account ramp (services/send-ramp.ts) caps a young workspace's daily
// sends below its plan. It used to be invisible until a campaign paused on it,
// so a day-old account read the pause as its plan running out. Shown only while
// a ceiling applies.
function RampNote({ account }: { account: Account }) {
  const limit = rampDailyLimit(account);
  if (limit === null) return null;
  return (
    <p className="text-xs text-muted-foreground">
      New workspace: up to {limit.toLocaleString()} emails a day while your sending warms up.
      The ceiling rises on its own and lifts after two weeks.
    </p>
  );
}
