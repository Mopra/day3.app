"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Globe, Mail } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { OrbitLoaderScreen } from "@/components/ui/orbit-loader";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ListCount,
  ListEmpty,
  ListFilter,
  ListNoResults,
  ListSearch,
  ListSkeleton,
  ListToolbar,
  SortableHead,
  useListController,
} from "@/components/ui/data-list";
import { useApi } from "@/lib/api";
import { formatDate, statusLabel, statusVariant } from "@/lib/format";
import { planLabel } from "@/lib/plans-catalog";
import type { Account, AccountHealth, Campaign, SendingDomain } from "@/lib/types";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
  const [domains, setDomains] = useState<SendingDomain[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [campaignStatus, setCampaignStatus] = useState("all");

  const load = useCallback(() => {
    api
      .get<Detail>(`/api/admin/accounts/${id}`)
      .then(setDetail)
      .catch((err) => toast.error(err.message));
    api
      .get<{ domains: SendingDomain[] }>(`/api/admin/accounts/${id}/domains`)
      .then((res) => setDomains(res.domains))
      .catch(() => setDomains([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(load, [load]);

  // Hooks must run before the loading early-return, so the controller takes the
  // campaigns once `detail` resolves.
  const campaignStatusOptions = useMemo(() => {
    const present = Array.from(new Set((detail?.campaigns ?? []).map((c) => c.status)));
    return [
      { value: "all", label: "All statuses" },
      ...present.map((s) => ({ value: s, label: cap(statusLabel(s)) })),
    ];
  }, [detail]);

  const campaignList = useListController(detail?.campaigns ?? null, {
    searchText: (c) => `${c.name} ${c.subject}`,
    predicate: (c) => campaignStatus === "all" || c.status === campaignStatus,
    sortAccessors: {
      name: (c) => c.name,
      status: (c) => c.status,
      risk: (c) => c.riskLevel,
      createdAt: (c) => c.createdAt,
    },
    initialSort: { key: "createdAt", dir: "desc" },
  });

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

  if (!detail) return <OrbitLoaderScreen />;
  const { account, health, subscriberCount } = detail;

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
            <span className="text-xl font-semibold">{planLabel(account.plan)}</span>{" "}
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
            <span className="text-xl font-semibold tabular-nums">
              {account.monthlyEmailSentCount.toLocaleString()}/
              {account.monthlyEmailLimit.toLocaleString()}
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
          {domains === null ? (
            <ListSkeleton rows={2} />
          ) : domains.length === 0 ? (
            <ListEmpty icon={Globe} title="No domains" description="This account hasn't added a sending domain yet." />
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
            Campaigns{" "}
            <span className="text-muted-foreground">
              ({subscriberCount.toLocaleString()} subscribers)
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {detail.campaigns.length === 0 ? (
            <ListEmpty icon={Mail} title="No campaigns" description="This account hasn't created a campaign yet." />
          ) : (
            <>
              <ListToolbar className="mb-4">
                <ListSearch
                  value={campaignList.search}
                  onChange={campaignList.setSearch}
                  placeholder="Search campaigns…"
                />
                <ListFilter
                  value={campaignStatus}
                  onChange={setCampaignStatus}
                  options={campaignStatusOptions}
                  ariaLabel="Filter by status"
                />
                <ListCount
                  shown={campaignList.shown}
                  total={campaignList.total}
                  noun="campaign"
                  className="ml-auto"
                />
              </ListToolbar>
              {campaignList.isFilteredEmpty ? (
                <ListNoResults
                  onClear={() => {
                    campaignList.setSearch("");
                    setCampaignStatus("all");
                  }}
                />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableHead label="Name" sortKey="name" sort={campaignList.sort} onSort={campaignList.toggleSort} />
                      <SortableHead label="Status" sortKey="status" sort={campaignList.sort} onSort={campaignList.toggleSort} />
                      <SortableHead label="Risk" sortKey="risk" sort={campaignList.sort} onSort={campaignList.toggleSort} />
                      <SortableHead label="Created" sortKey="createdAt" sort={campaignList.sort} onSort={campaignList.toggleSort} />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {campaignList.view!.map((cmp) => (
                      <TableRow key={cmp.id}>
                        <TableCell className="font-medium">{cmp.name}</TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(cmp.status)}>{statusLabel(cmp.status)}</Badge>
                        </TableCell>
                        <TableCell>{cmp.riskLevel ?? "—"}</TableCell>
                        <TableCell className="text-muted-foreground">{formatDate(cmp.createdAt)}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </CardContent>
      </Card>

      <Link href="/admin" className="text-sm text-primary underline-offset-4 hover:underline">
        ← Back to admin
      </Link>
    </div>
  );
}
