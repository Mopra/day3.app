"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/lib/api";
import { formatDate, statusLabel, statusVariant } from "@/lib/format";
import { planLabel } from "@/lib/plans-catalog";
import { UpgradeNudge, UsageSummary } from "@/components/plan-usage";
import { PlanSlider } from "@/components/plan-slider";
import type { Account } from "@/lib/types";

// A past-due payment is the one billing state that needs the user to act outside
// the plan picker — it's fixed in the organization billing settings (Clerk's
// <OrganizationProfile>), so its CTA points at Settings. Everything else in the
// bandwidth model is a self-serve plan change handled by the grid, which drives
// Clerk Billing's checkout/subscription drawers directly.
function pastDueNotice(status: string) {
  if (status !== "past_due") return null;
  return {
    title: "Payment past due",
    body: "Your last payment failed, so sending is paused. Update your payment method to resume — your plan and audience are untouched.",
  };
}

// The initial account row arrives from the server render (./page.tsx) — the
// authoritative, webhook-maintained row, the same one the reconcile poll below
// re-reads. Neither path calls POST /api/account/sync: that cost 2–3 Clerk API
// round trips per mount, and re-deriving the plan from the (laggy) session claim
// could show a stale tier right after a change. The once-per-session sync in
// <AppShell> covers the tester-override / webhook-less fallback.
export function BillingView({ initialAccount }: { initialAccount: Account }) {
  const api = useApi();
  const [account, setAccount] = useState<Account>(initialAccount);
  useEffect(() => setAccount(initialAccount), [initialAccount]);
  // Latest account, read by the reconcile baseline from a callback (not render).
  const accountRef = useRef<Account>(initialAccount);
  useEffect(() => {
    accountRef.current = account;
  }, [account]);

  // After a plan change, Clerk settles asynchronously: the `subscriptionItem.active`
  // webhook writes the new plan/status to our row, and the session token's plan
  // claim refreshes on its own cycle. A single read can still show the old plan, so
  // we poll the read-only account until the plan/status actually changes (or we give
  // up), and the page reflects reality without a manual refresh. We read GET
  // /api/account (the stored row the webhook updates), not the sync endpoint — the
  // latter would re-derive the plan from the session claim, which may still be stale.
  const reconcileTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconcileRun = useRef(0);
  const reconcile = useCallback(() => {
    const runId = ++reconcileRun.current; // supersede any in-flight reconcile
    if (reconcileTimer.current) clearTimeout(reconcileTimer.current);
    const before = accountRef.current;
    const beforeKey = `${before.plan}:${before.subscriptionStatus}`;
    const MAX_ATTEMPTS = 8; // ~12s of polling
    const INTERVAL_MS = 1500;
    let attempt = 0;

    const tick = async () => {
      if (runId !== reconcileRun.current) return; // a newer change took over
      attempt += 1;
      try {
        const { account: fresh } = await api.get<{ account: Account }>("/api/account");
        if (runId !== reconcileRun.current) return;
        setAccount(fresh);
        if (`${fresh.plan}:${fresh.subscriptionStatus}` !== beforeKey) return; // settled
      } catch {
        // Transient error — keep polling; the next attempt may succeed.
      }
      if (attempt < MAX_ATTEMPTS) {
        reconcileTimer.current = setTimeout(tick, INTERVAL_MS);
      }
    };
    void tick();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (reconcileTimer.current) clearTimeout(reconcileTimer.current);
    },
    [],
  );

  const notice = pastDueNotice(account.subscriptionStatus);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl">Billing</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Every feature is included on every plan. You only pick how many emails you
          send each month — upgrade or downgrade anytime.
        </p>
      </div>

      {notice && (
        <Alert variant="destructive">
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            <span>{notice.body}</span>
            <Button
              variant="outline"
              size="sm"
              render={<Link href="/settings">Update payment method</Link>}
            />
          </AlertDescription>
        </Alert>
      )}

      <Card className="ring-0">
        <CardHeader>
          <CardTitle className="text-base">Current plan</CardTitle>
        </CardHeader>
        <CardContent>
          {account ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
                <div className="flex items-center gap-2">
                  <span className="text-xl font-semibold">{planLabel(account.plan)}</span>
                  <Badge variant={statusVariant(account.subscriptionStatus)}>
                    {statusLabel(account.subscriptionStatus)}
                  </Badge>
                </div>
                {account.subscriptionStatus === "active" && account.currentPeriodEnd && (
                  <div className="text-muted-foreground">
                    Renews {formatDate(account.currentPeriodEnd)}
                  </div>
                )}
              </div>

              <div className="max-w-md">
                <UsageSummary account={account} />
              </div>

              <UpgradeNudge account={account} />
            </div>
          ) : (
            <Skeleton className="h-20 w-full max-w-md" />
          )}
        </CardContent>
      </Card>

      <Card className="ring-0">
        <CardHeader>
          <CardTitle className="text-base">Pick your plan</CardTitle>
        </CardHeader>
        <CardContent>
          {account ? (
            // Slide along the bandwidth ladder to find the tier that covers your
            // volume; Clerk Billing handles checkout and proration behind the CTA,
            // and reconcile polls until the new plan settles into the account.
            <PlanSlider account={account} onChanged={reconcile} />
          ) : (
            <Skeleton className="h-48 w-full" />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
