"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useOrganization } from "@clerk/nextjs";
import { Activity, Gem, Send } from "lucide-react";
import type { LucideIcon } from "lucide-react";
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
import { RowOpen, rowLinkProps } from "@/components/ui/data-list";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { formatDate, statusLabel, statusVariant } from "@/lib/format";
import { planCanSend, planLabel } from "@/lib/plans-catalog";
import { OnboardingChecklist } from "@/components/onboarding-checklist";
import { UpgradeNudge, UsageBar, usageInfo } from "@/components/plan-usage";
import type { Account, AccountHealth, CampaignListItem, OnboardingState } from "@/lib/types";

// A single KPI tile. Every stat card shares this skeleton — a muted label with a
// trailing icon, a prominent value, and a footer pinned to the bottom — so the
// three read as one aligned set regardless of how tall their values run.
function StatCard({
  label,
  icon: Icon,
  children,
  footer,
}: {
  label: string;
  icon: LucideIcon;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <Card>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div className="flex items-center justify-between gap-2">
          <span className="text-sm font-medium text-muted-foreground">{label}</span>
          <Icon className="size-4 shrink-0 text-muted-foreground/60" aria-hidden />
        </div>
        <div className="flex flex-1 flex-col">
          <div>{children}</div>
          <div className="mt-auto pt-3 text-sm">{footer}</div>
        </div>
      </CardContent>
    </Card>
  );
}

export default function DashboardPage() {
  const api = useApi();
  const router = useRouter();
  const { organization } = useOrganization();
  const [account, setAccount] = useState<Account | null>(null);
  const [health, setHealth] = useState<AccountHealth | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
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
        // Onboarding state is computed from the synced account, so fetch it
        // after sync to reflect the latest billing entitlements.
        const ob = await api.get<{ onboarding: OnboardingState }>("/api/account/onboarding");
        setOnboarding(ob.onboarding);
      })
      .catch((err) => toast.error(err.message));
    api
      .get<{ campaigns: CampaignListItem[] }>("/api/campaigns")
      .then((res) => setCampaigns(res.campaigns.slice(0, 5)))
      .catch(() => setCampaigns([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization?.id]);

  // Derived, once, so the value and footer of each card stay in sync.
  const usage = account && planCanSend(account.plan) ? usageInfo(account) : null;
  const sendingDegraded = !!health && health.status !== "normal";
  const statusDot = !account
    ? "bg-muted-foreground/40"
    : !account.sendingEnabled
      ? "bg-destructive"
      : sendingDegraded
        ? "bg-amber-500"
        : "bg-emerald-500";

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {organization?.name
              ? `Sending overview for ${organization.name}.`
              : "Your sending overview."}
          </p>
        </div>
        <Button render={<Link href="/campaigns/new">New campaign</Link>} />
      </div>

      {account?.riskStatus === "paused" && (
        <Alert variant="destructive">
          <AlertTitle>Sending is paused</AlertTitle>
          <AlertDescription>{account.pausedReason ?? "Contact support."}</AlertDescription>
        </Alert>
      )}

      {/* Usage-driven upgrade path: only appears when the account is running low
          on (or has exhausted) its monthly allowance and a bigger tier exists.
          Hidden when risk-paused, where the alert above is the real next step. */}
      {account?.riskStatus !== "paused" && account && <UpgradeNudge account={account} />}

      {onboarding && <OnboardingChecklist onboarding={onboarding} />}

      <div className="grid gap-4 md:grid-cols-3">
        <StatCard
          label="Plan"
          icon={Gem}
          footer={
            <Link
              href="/billing"
              className="text-primary underline-offset-4 hover:underline"
            >
              Manage plan
            </Link>
          }
        >
          {account ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-2xl font-semibold">{planLabel(account.plan)}</span>
              <Badge variant={account.subscriptionStatus === "active" ? "default" : "outline"}>
                {account.subscriptionStatus}
              </Badge>
            </div>
          ) : (
            <Skeleton className="h-8 w-24" />
          )}
        </StatCard>

        <StatCard
          label="Emails this month"
          icon={Send}
          footer={
            !account ? (
              <Skeleton className="h-4 w-20" />
            ) : usage ? (
              <span className="text-muted-foreground tabular-nums">
                {usage.state === "over"
                  ? "Limit reached"
                  : `${Math.max(0, usage.limit - usage.used).toLocaleString()} left`}
              </span>
            ) : (
              <Link
                href="/billing"
                className="text-primary underline-offset-4 hover:underline"
              >
                Subscribe to start sending
              </Link>
            )
          }
        >
          {!account ? (
            <Skeleton className="h-8 w-32" />
          ) : usage ? (
            <div className="space-y-2">
              <div className="text-2xl font-semibold tabular-nums">
                {account.monthlyEmailSentCount.toLocaleString()}
                <span className="text-base font-normal text-muted-foreground">
                  {" "}
                  / {account.monthlyEmailLimit.toLocaleString()}
                </span>
              </div>
              <UsageBar info={usage} />
            </div>
          ) : (
            <span className="text-2xl font-semibold text-muted-foreground">—</span>
          )}
        </StatCard>

        <StatCard
          label="Sending status"
          icon={Activity}
          footer={
            !account ? (
              <Skeleton className="h-4 w-24" />
            ) : !account.sendingEnabled ? (
              <span className="text-muted-foreground">Sending is turned off</span>
            ) : sendingDegraded ? (
              <span className="text-muted-foreground tabular-nums">
                Bounce {(health!.bounceRate * 100).toFixed(2)}% · Complaints{" "}
                {(health!.complaintRate * 100).toFixed(3)}%
              </span>
            ) : (
              <span className="text-muted-foreground">Operating normally</span>
            )
          }
        >
          {account ? (
            <span className="inline-flex items-center gap-2 text-2xl font-semibold">
              <span className={cn("size-2.5 rounded-full", statusDot)} aria-hidden />
              {account.sendingEnabled ? "Enabled" : "Disabled"}
            </span>
          ) : (
            <Skeleton className="h-8 w-28" />
          )}
        </StatCard>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Recent campaigns</CardTitle>
          {campaigns && campaigns.length > 0 && (
            <Link
              href="/campaigns"
              className="text-sm text-primary underline-offset-4 hover:underline"
            >
              View all
            </Link>
          )}
        </CardHeader>
        <CardContent className="px-0">
          {campaigns === null ? (
            <div className="px-4">
              <Skeleton className="h-24 w-full" />
            </div>
          ) : campaigns.length === 0 ? (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">
              No campaigns yet.{" "}
              <Link href="/campaigns/new" className="text-primary underline-offset-4 hover:underline">
                Create the first one
              </Link>
              .
            </p>
          ) : (
            <Table className="[&_td:first-child]:pl-4 [&_td:last-child]:pr-4 [&_th:first-child]:pl-4 [&_th:last-child]:pr-4">
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Sent</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {campaigns.map((c) => (
                  <TableRow key={c.id} {...rowLinkProps(() => router.push(`/campaigns/${c.id}`))}>
                    <TableCell>
                      <Link
                        href={`/campaigns/${c.id}`}
                        className="font-medium hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {c.name}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(c.status)}>{statusLabel(c.status)}</Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.sentCount.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(c.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <RowOpen href={`/campaigns/${c.id}`} />
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
