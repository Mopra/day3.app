"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useOrganization } from "@clerk/nextjs";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApi } from "@/lib/api";
import { formatDate, statusLabel, statusVariant } from "@/lib/format";
import type { Account, AccountHealth, CampaignListItem } from "@/lib/types";

export default function DashboardPage() {
  const api = useApi();
  const { organization } = useOrganization();
  const [account, setAccount] = useState<Account | null>(null);
  const [health, setHealth] = useState<AccountHealth | null>(null);
  const [campaigns, setCampaigns] = useState<CampaignListItem[] | null>(null);

  useEffect(() => {
    // Sync resolves the local account and refreshes billing entitlements
    // from Clerk on every dashboard load.
    api
      .post<{ account: Account }>("/api/account/sync")
      .then(async ({ account }) => {
        setAccount(account);
        const res = await api.get<{ account: Account; health: AccountHealth }>("/api/account");
        setAccount(res.account);
        setHealth(res.health);
      })
      .catch((err) => toast.error(err.message));
    api
      .get<{ campaigns: CampaignListItem[] }>("/api/campaigns")
      .then((res) => setCampaigns(res.campaigns.slice(0, 5)))
      .catch(() => setCampaigns([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization?.id]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
        <div className="flex gap-2">
          <Link href="/campaigns/new">
            <Button>New campaign</Button>
          </Link>
        </div>
      </div>

      {account?.riskStatus === "paused" && (
        <Alert variant="destructive">
          <AlertTitle>Sending is paused</AlertTitle>
          <AlertDescription>{account.pausedReason ?? "Contact support."}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Plan</CardTitle>
          </CardHeader>
          <CardContent>
            {account ? (
              <div className="flex items-center gap-2">
                <span className="text-2xl font-semibold capitalize">{account.plan}</span>
                <Badge variant={account.subscriptionStatus === "active" ? "default" : "outline"}>
                  {account.subscriptionStatus}
                </Badge>
              </div>
            ) : (
              <Skeleton className="h-8 w-24" />
            )}
            {account?.plan === "none" && (
              <Link href="/billing" className="mt-2 block text-sm text-primary underline-offset-4 hover:underline">
                Subscribe to start sending
              </Link>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Emails this month</CardTitle>
          </CardHeader>
          <CardContent>
            {account ? (
              <span className="text-2xl font-semibold">
                {account.monthlyEmailSentCount.toLocaleString()}
                <span className="text-base font-normal text-muted-foreground">
                  {" "}
                  / {account.monthlyEmailLimit.toLocaleString()}
                </span>
              </span>
            ) : (
              <Skeleton className="h-8 w-32" />
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Sending status</CardTitle>
          </CardHeader>
          <CardContent>
            {account ? (
              <div className="space-y-1">
                <Badge variant={account.sendingEnabled ? "default" : "destructive"}>
                  {account.sendingEnabled ? "Enabled" : "Disabled"}
                </Badge>
                {health && health.status !== "normal" && (
                  <p className="text-xs text-muted-foreground">
                    Bounce {(health.bounceRate * 100).toFixed(2)}% · Complaints{" "}
                    {(health.complaintRate * 100).toFixed(3)}%
                  </p>
                )}
              </div>
            ) : (
              <Skeleton className="h-8 w-24" />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent campaigns</CardTitle>
        </CardHeader>
        <CardContent>
          {campaigns === null ? (
            <Skeleton className="h-24 w-full" />
          ) : campaigns.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No campaigns yet.{" "}
              <Link href="/campaigns/new" className="text-primary underline-offset-4 hover:underline">
                Create the first one
              </Link>
              .
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Sent</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell>
                      <Link href={`/campaigns/${c.id}`} className="font-medium hover:underline">
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(c.status)}>{statusLabel(c.status)}</Badge>
                    </TableCell>
                    <TableCell>{c.sentCount}</TableCell>
                    <TableCell>{formatDate(c.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
