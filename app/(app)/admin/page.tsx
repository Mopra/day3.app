"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApi } from "@/lib/api";
import { statusLabel, statusVariant } from "@/lib/format";
import type { Account } from "@/lib/types";

type Overview = {
  accounts: number;
  pausedAccounts: number;
  campaignsByStatus: Record<string, number>;
};

export default function AdminOverviewPage() {
  const api = useApi();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);

  useEffect(() => {
    api
      .get<Overview>("/api/admin/overview")
      .then(setOverview)
      .catch((err) => toast.error(err.message));
    api
      .get<{ accounts: Account[] }>("/api/admin/accounts")
      .then((res) => setAccounts(res.accounts))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Admin</h1>
        <Link href="/admin/reviews" className="text-sm text-primary underline-offset-4 hover:underline">
          Campaign reviews →
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Accounts</CardTitle>
          </CardHeader>
          <CardContent>
            {overview ? (
              <span className="text-2xl font-semibold">{overview.accounts}</span>
            ) : (
              <Skeleton className="h-8 w-12" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Paused accounts</CardTitle>
          </CardHeader>
          <CardContent>
            {overview ? (
              <span className="text-2xl font-semibold">{overview.pausedAccounts}</span>
            ) : (
              <Skeleton className="h-8 w-12" />
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Campaigns</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {overview ? (
              Object.entries(overview.campaignsByStatus).map(([status, count]) => (
                <Badge key={status} variant={statusVariant(status)}>
                  {statusLabel(status)}: {count}
                </Badge>
              ))
            ) : (
              <Skeleton className="h-8 w-32" />
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Accounts</CardTitle>
        </CardHeader>
        <CardContent>
          {accounts === null ? (
            <Skeleton className="h-24 w-full" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Plan</TableHead>
                  <TableHead>Subscription</TableHead>
                  <TableHead>Sending</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead>Used</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {accounts.map((a) => (
                  <TableRow key={a.id}>
                    <TableCell>
                      <Link href={`/admin/accounts/${a.id}`} className="font-medium hover:underline">
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell className="capitalize">{a.plan}</TableCell>
                    <TableCell>
                      <Badge variant={a.subscriptionStatus === "active" ? "default" : "outline"}>
                        {a.subscriptionStatus}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={a.sendingEnabled ? "default" : "destructive"}>
                        {a.sendingEnabled ? "enabled" : "disabled"}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge variant={a.riskStatus === "normal" ? "outline" : "destructive"}>
                        {a.riskStatus}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {a.monthlyEmailSentCount}/{a.monthlyEmailLimit}
                    </TableCell>
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
