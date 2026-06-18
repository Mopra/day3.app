"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
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
import { formatDate, statusLabel, statusVariant } from "@/lib/format";
import type { Account, AccountHealth, Campaign, SendingDomain } from "@/lib/types";

type Detail = {
  account: Account;
  health: AccountHealth;
  campaigns: Campaign[];
  subscriberCount: number;
};

export default function AdminAccountPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const [detail, setDetail] = useState<Detail | null>(null);
  const [domains, setDomains] = useState<SendingDomain[]>([]);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<Detail>(`/api/admin/accounts/${id}`)
      .then(setDetail)
      .catch((err) => toast.error(err.message));
    api
      .get<{ domains: SendingDomain[] }>(`/api/admin/accounts/${id}/domains`)
      .then((res) => setDomains(res.domains))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(load, [load]);

  if (!detail) return <Skeleton className="h-64 w-full" />;
  const { account, health, campaigns, subscriberCount } = detail;

  async function act(path: string, body?: unknown) {
    setBusy(true);
    try {
      await api.post(path, body ?? {});
      toast.success("Done");
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{account.name}</h1>
          <Badge variant={account.riskStatus === "normal" ? "outline" : "destructive"}>
            {account.riskStatus}
          </Badge>
        </div>
        <div className="flex gap-2">
          {account.riskStatus === "paused" ? (
            <Button
              disabled={busy}
              onClick={() => act(`/api/admin/accounts/${account.id}/resume`)}
            >
              Resume account
            </Button>
          ) : (
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const reason = window.prompt("Reason for pausing this account?");
                if (reason) act(`/api/admin/accounts/${account.id}/pause`, { reason });
              }}
            >
              Pause account
            </Button>
          )}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Plan</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-semibold capitalize">{account.plan}</span>{" "}
            <Badge variant={account.subscriptionStatus === "active" ? "default" : "outline"}>
              {account.subscriptionStatus}
            </Badge>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Usage</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-semibold">
              {account.monthlyEmailSentCount}/{account.monthlyEmailLimit}
            </span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Bounce rate</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-semibold">{(health.bounceRate * 100).toFixed(2)}%</span>
            <span className="text-xs text-muted-foreground"> of {health.attempted}</span>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm text-muted-foreground">Complaint rate</CardTitle>
          </CardHeader>
          <CardContent>
            <span className="text-xl font-semibold">
              {(health.complaintRate * 100).toFixed(3)}%
            </span>
          </CardContent>
        </Card>
      </div>

      {account.pausedReason && (
        <p className="text-sm text-destructive">Paused: {account.pausedReason}</p>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sending domains</CardTitle>
        </CardHeader>
        <CardContent>
          {domains.length === 0 ? (
            <p className="text-sm text-muted-foreground">No domains.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.domain}</TableCell>
                    <TableCell>
                      {d.adminOverrideVerified ? (
                        <Badge>verified (override)</Badge>
                      ) : (
                        <Badge
                          variant={d.verificationStatus === "verified" ? "default" : "secondary"}
                        >
                          {d.verificationStatus}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {!d.adminOverrideVerified && d.verificationStatus !== "verified" && (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={busy}
                          onClick={() => act(`/api/admin/domains/${d.id}/override-verify`)}
                        >
                          Override verify
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            Campaigns <span className="text-muted-foreground">({subscriberCount} subscribers)</span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {campaigns.length === 0 ? (
            <p className="text-sm text-muted-foreground">No campaigns.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Risk</TableHead>
                  <TableHead>Created</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((cmp) => (
                  <TableRow key={cmp.id}>
                    <TableCell className="font-medium">{cmp.name}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(cmp.status)}>{statusLabel(cmp.status)}</Badge>
                    </TableCell>
                    <TableCell>{cmp.riskLevel ?? "—"}</TableCell>
                    <TableCell>{formatDate(cmp.createdAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Link href="/admin" className="text-sm text-primary underline-offset-4 hover:underline">
        ← Back to admin
      </Link>
    </div>
  );
}
