"use client";

// Shared AI-budget state for the dashboard. Mounted once in <AppShell> so the
// sidebar meter and the campaign composer read the SAME snapshot: the composer
// spends budget (and calls refresh() after each AI action), and the sidebar
// meter updates live from the same context. The budget is shown in exactly one
// place — the sidebar, just above the organization switcher.
import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { useApi } from "@/lib/api";

// The per-org AI budget snapshot from /api/ai/status (see lib/ai-budget.ts).
export type AiBudget = {
  percentUsed: number;
  usedCredits: number;
  limitCredits: number;
  exhausted: boolean;
  reason: "window" | "month" | null;
  resetsInSeconds: number;
};
type AiStatusResponse = {
  enabled: boolean;
  configured: boolean;
  planAi: boolean;
  budget: AiBudget | null;
};

type AiBudgetContextValue = {
  /** True when AI is configured AND included on the account's plan. */
  enabled: boolean;
  /** True when OpenRouter is configured at all (independent of plan). */
  configured: boolean;
  /** True when the account's plan tier includes the AI assistant. */
  planAi: boolean;
  /** Null until the first fetch resolves, or when AI is disabled. */
  budget: AiBudget | null;
  /** Re-read the snapshot — call after any action that spends budget. */
  refresh: () => Promise<void>;
};

const AiBudgetContext = createContext<AiBudgetContextValue | null>(null);

export function AiBudgetProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [enabled, setEnabled] = useState(false);
  const [configured, setConfigured] = useState(false);
  const [planAi, setPlanAi] = useState(false);
  const [budget, setBudget] = useState<AiBudget | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await api.get<AiStatusResponse>("/api/ai/status");
      setEnabled(res.enabled);
      setConfigured(res.configured);
      setPlanAi(res.planAi);
      setBudget(res.budget);
    } catch {
      // Non-fatal: keep the last known value (meter just doesn't update).
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AiBudgetContext.Provider value={{ enabled, configured, planAi, budget, refresh }}>
      {children}
    </AiBudgetContext.Provider>
  );
}

export function useAiBudget(): AiBudgetContextValue {
  const ctx = useContext(AiBudgetContext);
  if (!ctx) throw new Error("useAiBudget must be used within an AiBudgetProvider");
  return ctx;
}
