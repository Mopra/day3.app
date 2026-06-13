import { useCallback, useEffect, useState } from "react";
import { PricingTable } from "@clerk/react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "../lib/api";
import type { Account } from "../lib/types";

export function BillingPage() {
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

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Current plan</CardTitle>
        </CardHeader>
        <CardContent>
          {account ? (
            <div className="flex flex-wrap items-center gap-6 text-sm">
              <div className="flex items-center gap-2">
                <span className="text-xl font-semibold capitalize">{account.plan}</span>
                <Badge variant={account.subscriptionStatus === "active" ? "default" : "outline"}>
                  {account.subscriptionStatus}
                </Badge>
              </div>
              <div className="text-muted-foreground">
                {account.monthlyEmailSentCount.toLocaleString()} /{" "}
                {account.monthlyEmailLimit.toLocaleString()} emails this month
              </div>
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
