import { HttpError } from "@/api/http";
import { getRedisConnection } from "@/queue/producer";

// Per-organization AI usage budget for the campaign-composer AI helpers
// (draft / subject ideas / preview text / rewrite). The AI calls are paid
// OpenRouter requests, so an unbounded org could quietly burn the thin margin on
// the plan. This caps spend the way Claude's own limits work: a rolling 5-hour
// window that auto-resets, surfaced to the user as a percentage and a subtle
// "resets in Xh Ym".
//
// Design choices (mirrors lib/rate-limit.ts, deliberately):
//   - Redis is the store. Budget is throttling state, not billing-grade
//     accounting — the per-request rate limiter already lives here. No schema
//     change, and the rolling reset is just a key TTL.
//   - We meter REAL token usage and convert it to a dollar cost (input/output
//     priced separately — output dominates). Cost is tracked in micro-dollars
//     (integers) so Redis INCRBY stays exact. "Credits" are the friendly unit:
//     1 credit = $0.01 of AI spend.
//   - Two buckets, both keyed by account_id:
//       * window  — the visible 5-hour rolling limit (TTL = window length).
//       * month   — a silent hard backstop so a runaway org can't exceed the
//                   per-org monthly ceiling across many windows. Set to 0 to
//                   disable. Keyed by calendar month so it resets on the 1st.
//   - Check-before / record-after: we gate on the CURRENT usage before the call
//     (we can't know the cost until after), then add the real cost. A single
//     call can therefore overshoot the cap slightly — acceptable for a guard
//     rail, same boundary trade-off the fixed-window limiter makes.
//   - Fails OPEN: if Redis is unreachable the request is allowed (the feature
//     must not hard-fail on a cache outage) but the condition is logged.

// The slice of ioredis we use — kept narrow so tests can inject a fake.
export interface AiBudgetStore {
  incrby(key: string, increment: number): Promise<number>;
  pexpire(key: string, ms: number): Promise<unknown>;
  pttl(key: string): Promise<number>;
  get(key: string): Promise<string | null>;
}

// The token counts an AI SDK call reports. Field names tolerate both the AI SDK
// v6 shape (input/outputTokens) and the legacy v4 shape (prompt/completionTokens)
// so a provider/SDK quirk degrades to a safe under-count, never a crash.
export type TokenUsage = {
  inputTokens?: number | null;
  outputTokens?: number | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
} | null | undefined;

const MICRO_PER_DOLLAR = 1_000_000;
// 1 credit = one US cent of AI spend. Keeps the budget numbers human and maps
// directly to dollars: 30 credits = $0.30.
const DOLLARS_PER_CREDIT = 0.01;

// Env-tunable knobs (read live each call, like RATE_LIMIT_*). Defaults below.
function envNum(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(`[ai-budget] ignoring malformed ${name}="${raw}"; using default ${fallback}`);
    return fallback;
  }
  return n;
}

// $/Mtok → micro-$/token is the same number ($3/Mtok = 3 µ$/token), so the
// per-Mtok dollar figure doubles as the micro-dollar-per-token multiplier.
function inputMicroPerToken(): number {
  return envNum("AI_PRICE_INPUT_PER_MTOK", 3);
}
function outputMicroPerToken(): number {
  return envNum("AI_PRICE_OUTPUT_PER_MTOK", 15);
}

function windowMs(): number {
  return Math.round(envNum("AI_BUDGET_WINDOW_HOURS", 5) * 3_600_000);
}
function creditsToMicro(credits: number): number {
  return Math.round(credits * DOLLARS_PER_CREDIT * MICRO_PER_DOLLAR);
}
function windowBudgetMicro(): number {
  return creditsToMicro(envNum("AI_BUDGET_WINDOW_CREDITS", 30));
}
// 0 disables the monthly backstop entirely.
function monthlyBudgetMicro(): number {
  return creditsToMicro(envNum("AI_BUDGET_MONTHLY_CREDITS", 200));
}

function microToCredits(micro: number): number {
  return micro / (DOLLARS_PER_CREDIT * MICRO_PER_DOLLAR);
}

/** Normalize an AI SDK usage object to non-negative integer input/output tokens. */
export function normalizeUsage(usage: TokenUsage): { inputTokens: number; outputTokens: number } {
  const input = usage?.inputTokens ?? usage?.promptTokens ?? 0;
  const output = usage?.outputTokens ?? usage?.completionTokens ?? 0;
  return {
    inputTokens: Math.max(0, Math.round(input || 0)),
    outputTokens: Math.max(0, Math.round(output || 0)),
  };
}

/** Estimated cost of a call in micro-dollars, from its token usage. */
export function costMicroDollars(usage: TokenUsage): number {
  const { inputTokens, outputTokens } = normalizeUsage(usage);
  return Math.round(inputTokens * inputMicroPerToken() + outputTokens * outputMicroPerToken());
}

function windowKey(accountId: string): string {
  return `aibudget:w:${accountId}`;
}
function monthKey(accountId: string, now: Date): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `aibudget:m:${accountId}:${y}-${m}`;
}
// Milliseconds until 00:00 UTC on the 1st of next month (when the monthly bucket
// expires). Date.UTC rolls the year over for December.
function msUntilNextMonth(now: Date): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0);
  return Math.max(0, next - now.getTime());
}

async function readMicro(store: AiBudgetStore, key: string): Promise<number> {
  const raw = await store.get(key);
  if (!raw) return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export type AiBudgetSnapshot = {
  /** 0–100, of the visible 5-hour window (the user-facing meter). */
  percentUsed: number;
  /** Window credits used / budget, rounded for display. */
  usedCredits: number;
  limitCredits: number;
  /** True when the window OR the monthly backstop is spent → AI is disabled. */
  exhausted: boolean;
  /** Which limit is binding when exhausted (drives the reset copy). */
  reason: "window" | "month" | null;
  /** Seconds until the binding limit lifts (window TTL, or the month boundary). */
  resetsInSeconds: number;
};

const PERMISSIVE: AiBudgetSnapshot = {
  percentUsed: 0,
  usedCredits: 0,
  limitCredits: 0,
  exhausted: false,
  reason: null,
  resetsInSeconds: 0,
};

/**
 * Read the current budget state for an account WITHOUT mutating it. Fails open
 * (returns a permissive snapshot) and logs if the store is unreachable.
 */
export async function readAiBudget(
  accountId: string,
  store: AiBudgetStore = getRedisConnection(),
  now: Date = new Date(),
): Promise<AiBudgetSnapshot> {
  const windowBudget = windowBudgetMicro();
  const monthlyBudget = monthlyBudgetMicro();
  try {
    const [windowUsed, monthUsed, windowTtlMs] = await Promise.all([
      readMicro(store, windowKey(accountId)),
      monthlyBudget > 0 ? readMicro(store, monthKey(accountId, now)) : Promise.resolve(0),
      store.pttl(windowKey(accountId)),
    ]);

    const windowExhausted = windowBudget > 0 && windowUsed >= windowBudget;
    const monthExhausted = monthlyBudget > 0 && monthUsed >= monthlyBudget;

    // The monthly backstop is the longer wait, so it wins the reason/reset when
    // both are spent.
    const reason: AiBudgetSnapshot["reason"] = monthExhausted
      ? "month"
      : windowExhausted
        ? "window"
        : null;

    const windowResetSeconds =
      windowTtlMs > 0 ? Math.ceil(windowTtlMs / 1000) : Math.ceil(windowMs() / 1000);
    const resetsInSeconds =
      reason === "month" ? Math.ceil(msUntilNextMonth(now) / 1000) : windowResetSeconds;

    const percentUsed =
      windowBudget > 0 ? Math.min(100, Math.round((windowUsed / windowBudget) * 100)) : 0;

    return {
      percentUsed,
      usedCredits: Math.round(microToCredits(windowUsed)),
      limitCredits: Math.round(microToCredits(windowBudget)),
      exhausted: windowExhausted || monthExhausted,
      reason,
      resetsInSeconds,
    };
  } catch (err) {
    console.error(`[ai-budget] store unreachable for ${accountId}; failing open`, err);
    return { ...PERMISSIVE, limitCredits: Math.round(microToCredits(windowBudget)) };
  }
}

/**
 * Throw HttpError(429) with a Retry-After header when the account's AI budget is
 * spent. No-op when there's headroom. Pairs with the per-minute "ai" rate limit.
 */
export async function enforceAiBudget(
  accountId: string,
  store?: AiBudgetStore,
  now: Date = new Date(),
): Promise<void> {
  const snap = await readAiBudget(accountId, store, now);
  if (!snap.exhausted) return;
  const message =
    snap.reason === "month"
      ? "Your team's monthly AI assist budget is used up. It resets at the start of next month."
      : "Your team's AI assist budget is used up for now. It resets shortly — try again then.";
  throw new HttpError(429, message, { "Retry-After": String(Math.max(1, snap.resetsInSeconds)) });
}

/**
 * Add a completed call's cost to both buckets, seeding the TTL on first write.
 * Best-effort: a recording failure is logged but never thrown — it must not turn
 * a successful AI result into an error for the user.
 */
export async function recordAiUsage(
  accountId: string,
  usage: TokenUsage,
  store: AiBudgetStore = getRedisConnection(),
  now: Date = new Date(),
): Promise<void> {
  const cost = costMicroDollars(usage);
  if (cost <= 0) return;
  try {
    const wk = windowKey(accountId);
    const windowTotal = await store.incrby(wk, cost);
    // First write in a fresh window → start its TTL (the rolling reset clock).
    if (windowTotal === cost) await store.pexpire(wk, windowMs());

    if (monthlyBudgetMicro() > 0) {
      const mk = monthKey(accountId, now);
      const monthTotal = await store.incrby(mk, cost);
      if (monthTotal === cost) await store.pexpire(mk, msUntilNextMonth(now));
    }
  } catch (err) {
    console.error(`[ai-budget] failed to record usage for ${accountId}`, err);
  }
}
