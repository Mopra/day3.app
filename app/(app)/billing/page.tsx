"use client";

import { useCallback, useEffect, useState } from "react";
import { PricingTable } from "@clerk/nextjs";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/lib/api";
import { formatDate, statusLabel, statusVariant } from "@/lib/format";
import type { Account } from "@/lib/types";

// Surfaces a clear, actionable banner for the two states that block sending and
// need the user to act: a past-due payment and an ended subscription.
function billingNotice(
  status: string,
): { title: string; body: string; cta: string } | null {
  if (status === "past_due") {
    return {
      title: "Payment past due",
      body: "Your last payment failed, so sending is paused. Update your payment method below to resume.",
      cta: "Update payment method",
    };
  }
  if (status !== "active") {
    return {
      title: "No active subscription",
      body: "Choose a plan below to activate your account and start sending.",
      cta: "Choose a plan",
    };
  }
  return null;
}

export default function BillingPage() {
  const api = useApi();
  const [account, setAccount] = useState<Account | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  const sync = useCallback(() => {
    api
      .post<{ account: Account }>("/api/account/sync")
      .then((res) => setAccount(res.account))
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(sync, [sync]);

  const notice = account ? billingNotice(account.subscriptionStatus) : null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>

      {notice && (
        <Alert variant={account?.subscriptionStatus === "past_due" ? "destructive" : "default"}>
          <AlertTitle>{notice.title}</AlertTitle>
          <AlertDescription>
            {notice.body} {notice.cta} below.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current plan</CardTitle>
        </CardHeader>
        <CardContent>
          {account ? (
            <div className="flex flex-wrap items-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-xl font-semibold capitalize">{account.plan}</span>
                <Badge variant={statusVariant(account.subscriptionStatus)}>
                  {statusLabel(account.subscriptionStatus)}
                </Badge>
              </div>
              <div className="text-muted-foreground">
                {account.monthlyEmailSentCount.toLocaleString()} /{" "}
                {account.monthlyEmailLimit.toLocaleString()} emails this period
              </div>
              {account.subscriptionStatus === "active" &&
                account.currentPeriodEnd && (
                  <div className="text-muted-foreground">
                    Renews {formatDate(account.currentPeriodEnd)}
                  </div>
                )}
              <Button
                variant="outline"
                size="sm"
                disabled={refreshing}
                onClick={async () => {
                  setRefreshing(true);
                  try {
                    // The fresh session token carries current billing claims;
                    // sync mirrors them into the local account.
                    await api.post("/api/account/sync");
                    sync();
                    toast.success("Billing state refreshed");
                  } finally {
                    setRefreshing(false);
                  }
                }}
              >
                Refresh billing state
              </Button>
            </div>
          ) : (
            <Skeleton className="h-8 w-64" />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Plans</CardTitle>
        </CardHeader>
        <CardContent>
          {/* Clerk Billing handles checkout; the subscription belongs to the
              active organization. */}
          <PricingTable for="organization" newSubscriptionRedirectUrl="/billing" />
        </CardContent>
      </Card>
    </div>
  );
}
