"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { CheckCircle2, Users } from "lucide-react";
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
import {
  ListCount,
  ListEmpty,
  ListFilter,
  ListNoResults,
  ListSearch,
  ListSkeleton,
  ListToolbar,
  RowOpen,
  SortableHead,
  rowLinkProps,
  useListController,
} from "@/components/ui/data-list";
import { useApi } from "@/lib/api";
import { formatDateTime, statusLabel, statusVariant } from "@/lib/format";
import { planLabel } from "@/lib/plans-catalog";
import type { Account } from "@/lib/types";

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

type FailedJob = {
  id: string;
  jobType: string;
  entityType: string | null;
  entityId: string | null;
  status: string;
  error: string | null;
  createdAt: string;
};

type Overview = {
  accounts: number;
  pausedAccounts: number;
  campaignsByStatus: Record<string, number>;
  failedJobs: FailedJob[];
};

export default function AdminOverviewPage() {
  const api = useApi();
  const router = useRouter();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [accounts, setAccounts] = useState<Account[] | null>(null);
  const [risk, setRisk] = useState("all");
  const [jobStatus, setJobStatus] = useState("all");

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

  const riskOptions = useMemo(() => {
    const present = Array.from(new Set((accounts ?? []).map((a) => a.riskStatus)));
    return [
      { value: "all", label: "All accounts" },
      ...present.map((s) => ({ value: s, label: cap(s) })),
    ];
  }, [accounts]);

  const accountList = useListController(accounts, {
    searchText: (a) => a.name,
    predicate: (a) => risk === "all" || a.riskStatus === risk,
    sortAccessors: {
      name: (a) => a.name,
      plan: (a) => a.plan,
      subscription: (a) => a.subscriptionStatus,
      sending: (a) => a.sendingEnabled,
      risk: (a) => a.riskStatus,
      used: (a) => a.monthlyEmailSentCount,
    },
    initialSort: { key: "name", dir: "asc" },
  });

  const jobStatusOptions = useMemo(() => {
    const present = Array.from(new Set((overview?.failedJobs ?? []).map((j) => j.status)));
    return [
      { value: "all", label: "All states" },
      ...present.map((s) => ({ value: s, label: cap(statusLabel(s)) })),
    ];
  }, [overview]);

  const jobList = useListController(overview?.failedJobs ?? null, {
    searchText: (j) => `${j.jobType} ${j.entityType ?? ""} ${j.entityId ?? ""} ${j.error ?? ""}`,
    predicate: (j) => jobStatus === "all" || j.status === jobStatus,
    sortAccessors: {
      job: (j) => j.jobType,
      status: (j) => j.status,
      createdAt: (j) => j.createdAt,
    },
    initialSort: { key: "createdAt", dir: "desc" },
  });

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
          {accounts && accounts.length > 0 && (
            <ListToolbar className="mb-4">
              <ListSearch
                value={accountList.search}
                onChange={accountList.setSearch}
                placeholder="Search accounts…"
              />
              <ListFilter
                value={risk}
                onChange={setRisk}
                options={riskOptions}
                ariaLabel="Filter by risk"
              />
              <ListCount
                shown={accountList.shown}
                total={accountList.total}
                noun="account"
                className="ml-auto"
              />
            </ListToolbar>
          )}
          {accountList.view === null ? (
            <ListSkeleton />
          ) : accountList.isEmpty ? (
            <ListEmpty icon={Users} title="No accounts yet" />
          ) : accountList.isFilteredEmpty ? (
            <ListNoResults onClear={() => { accountList.setSearch(""); setRisk("all"); }} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="Name" sortKey="name" sort={accountList.sort} onSort={accountList.toggleSort} />
                  <SortableHead label="Plan" sortKey="plan" sort={accountList.sort} onSort={accountList.toggleSort} />
                  <SortableHead label="Subscription" sortKey="subscription" sort={accountList.sort} onSort={accountList.toggleSort} />
                  <SortableHead label="Sending" sortKey="sending" sort={accountList.sort} onSort={accountList.toggleSort} />
                  <SortableHead label="Risk" sortKey="risk" sort={accountList.sort} onSort={accountList.toggleSort} />
                  <SortableHead label="Used" sortKey="used" sort={accountList.sort} onSort={accountList.toggleSort} align="right" />
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {accountList.view.map((a) => (
                  <TableRow key={a.id} {...rowLinkProps(() => router.push(`/admin/accounts/${a.id}`))}>
                    <TableCell>
                      <Link
                        href={`/admin/accounts/${a.id}`}
                        className="font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {a.name}
                      </Link>
                    </TableCell>
                    <TableCell>{planLabel(a.plan)}</TableCell>
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
                    <TableCell className="text-right tabular-nums">
                      {a.monthlyEmailSentCount.toLocaleString()}/{a.monthlyEmailLimit.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right">
                      <RowOpen href={`/admin/accounts/${a.id}`} />
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
          <CardTitle className="text-base">Recent failed jobs</CardTitle>
        </CardHeader>
        <CardContent>
          {!overview ? (
            <ListSkeleton />
          ) : overview.failedJobs.length === 0 ? (
            <ListEmpty
              icon={CheckCircle2}
              title="All clear"
              description="No failed or dead-lettered jobs."
            />
          ) : (
            <>
              <ListToolbar className="mb-4">
                <ListSearch
                  value={jobList.search}
                  onChange={jobList.setSearch}
                  placeholder="Search jobs…"
                />
                <ListFilter
                  value={jobStatus}
                  onChange={setJobStatus}
                  options={jobStatusOptions}
                  ariaLabel="Filter by state"
                />
                <ListCount
                  shown={jobList.shown}
                  total={jobList.total}
                  noun="job"
                  className="ml-auto"
                />
              </ListToolbar>
              {jobList.isFilteredEmpty ? (
                <ListNoResults onClear={() => { jobList.setSearch(""); setJobStatus("all"); }} />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <SortableHead label="Job" sortKey="job" sort={jobList.sort} onSort={jobList.toggleSort} />
                      <SortableHead label="Status" sortKey="status" sort={jobList.sort} onSort={jobList.toggleSort} />
                      <TableHead>Entity</TableHead>
                      <TableHead>Error</TableHead>
                      <SortableHead label="When" sortKey="createdAt" sort={jobList.sort} onSort={jobList.toggleSort} />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {jobList.view!.map((j) => (
                      <TableRow key={j.id}>
                        <TableCell className="font-medium">{j.jobType}</TableCell>
                        <TableCell>
                          <Badge variant={statusVariant(j.status)}>{statusLabel(j.status)}</Badge>
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {j.entityType ? `${j.entityType}: ${j.entityId ?? "—"}` : "—"}
                        </TableCell>
                        <TableCell className="max-w-72 truncate text-muted-foreground">
                          {j.error ?? "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDateTime(j.createdAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
