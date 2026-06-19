"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
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
import { formatDateTime, statusLabel, statusVariant } from "@/lib/format";
import { sanitizeHtml } from "@/services/render";
import { CampaignForm, type CampaignFormValues } from "@/components/campaign-form";
import type { Campaign, CampaignStats, OnboardingState, Recipient, RiskReview } from "@/lib/types";

// Maps a send-blocking condition to the page that fixes it, so the user gets a
// link rather than a dead-end message.
function fixLinkFor(reason: string): { href: string; label: string } | null {
  const r = reason.toLowerCase();
  if (
    r.includes("subscription") ||
    r.includes("limit") ||
    r.includes("plan") ||
    r.includes("payment") ||
    r.includes("billing")
  ) {
    return { href: "/billing", label: "Go to billing" };
  }
  if (r.includes("domain")) {
    return { href: "/domains", label: "Verify a domain" };
  }
  if (r.includes("subscriber") || r.includes("audience") || r.includes("recipient")) {
    return { href: "/audiences", label: "Import subscribers" };
  }
  return null;
}

const STAT_KEYS: (keyof CampaignStats)[] = [
  "pending",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "unsubscribed",
  "failed",
  "skipped",
];

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const { user } = useUser();
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [riskReview, setRiskReview] = useState<RiskReview | null>(null);
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ campaign: Campaign; stats: CampaignStats; riskReview: RiskReview | null }>(
        `/api/campaigns/${id}`,
      )
      .then((res) => {
        setCampaign(res.campaign);
        setStats(res.stats);
        setRiskReview(res.riskReview);
      })
      .catch((err) => toast.error(err.message));
    api
      .get<{ onboarding: OnboardingState }>("/api/account/onboarding")
      .then((res) => setOnboarding(res.onboarding))
      .catch(() => {});
    api
      .get<{ recipients: Recipient[] }>(`/api/campaigns/${id}/recipients?limit=50`)
      .then((res) => setRecipients(res.recipients))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(load, [load]);

  // Live-update while the pipeline is working.
  const inFlight =
    campaign &&
    ["pending_review", "approved", "generating_recipients", "sending"].includes(campaign.status);
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(load, 2500);
    return () => clearInterval(t);
  }, [inFlight, load]);

  async function action(path: string, body?: unknown, success?: string) {
    setBusy(true);
    try {
      await api.post(`/api/campaigns/${id}/${path}`, body);
      if (success) toast.success(success);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  async function onSave(values: CampaignFormValues) {
    await api.patch(`/api/campaigns/${id}`, values);
    toast.success("Draft saved");
    load();
  }

  if (!campaign) return <Skeleton className="h-64 w-full" />;

  const ownEmail = user?.primaryEmailAddress?.emailAddress;
  const submittable = campaign.status === "draft" || campaign.status === "approved";
  // Pre-flight: mirror the submit route's send gates so the user sees an
  // actionable message (with a fix link) instead of clicking into a raw error.
  const sendBlocked = submittable && onboarding && !onboarding.canSend ? onboarding : null;
  const blockFix = sendBlocked?.sendBlockedReason
    ? fixLinkFor(sendBlocked.sendBlockedReason)
    : null;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
          <Badge variant={statusVariant(campaign.status)}>{statusLabel(campaign.status)}</Badge>
        </div>
        <div className="flex gap-2">
          {ownEmail && (
            <Button
              variant="outline"
              disabled={busy}
              onClick={() => action("test-email", { toEmail: ownEmail }, `Test sent to ${ownEmail}`)}
            >
              Send test to me
            </Button>
          )}
          {submittable && (
            <Button
              disabled={busy || !!sendBlocked}
              onClick={() => action("submit", undefined, "Campaign submitted")}
            >
              Submit & send
            </Button>
          )}
          {campaign.status === "sending" && (
            <Button variant="destructive" disabled={busy} onClick={() => action("pause")}>
              Pause
            </Button>
          )}
          {campaign.status === "paused" && (
            <Button disabled={busy} onClick={() => action("resume", undefined, "Resumed")}>
              Resume
            </Button>
          )}
        </div>
      </div>

      {campaign.pausedReason && campaign.status !== "sent" && (
        <Alert variant="destructive">
          <AlertTitle>{statusLabel(campaign.status)}</AlertTitle>
          <AlertDescription>{campaign.pausedReason}</AlertDescription>
        </Alert>
      )}

      {sendBlocked && (
        <Alert>
          <AlertTitle>This campaign can&apos;t be sent yet</AlertTitle>
          <AlertDescription>
            {sendBlocked.sendBlockedReason}
            {blockFix && (
              <>
                {" "}
                <Link href={blockFix.href} className="font-medium underline underline-offset-4">
                  {blockFix.label}
                </Link>
                .
              </>
            )}
          </AlertDescription>
        </Alert>
      )}

      {riskReview && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Risk review</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3 text-sm">
            <Badge
              variant={
                riskReview.riskLevel === "low"
                  ? "default"
                  : riskReview.riskLevel === "medium"
                    ? "secondary"
                    : "destructive"
              }
            >
              {riskReview.riskLevel} · {riskReview.riskScore}
            </Badge>
            <span className="text-muted-foreground">{riskReview.summary}</span>
          </CardContent>
        </Card>
      )}

      {stats && stats.total > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Stats</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-6">
              <div>
                <div className="text-2xl font-semibold">{stats.total}</div>
                <div className="text-xs text-muted-foreground">recipients</div>
              </div>
              {STAT_KEYS.map((key) =>
                stats[key] ? (
                  <div key={key}>
                    <div className="text-2xl font-semibold">{stats[key]}</div>
                    <div className="text-xs text-muted-foreground">{key}</div>
                  </div>
                ) : null,
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {campaign.status === "draft" ? (
        <CampaignForm initial={campaign} onSave={onSave} submitLabel="Save draft" />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Content</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="text-sm">
              <span className="text-muted-foreground">Subject: </span>
              {campaign.subject}
            </div>
            <div className="text-sm">
              <span className="text-muted-foreground">From: </span>
              {campaign.fromName} &lt;{campaign.fromEmail}&gt;
            </div>
            <div className="max-h-96 overflow-auto rounded-lg border border-border bg-white p-4">
              <iframe
                title="Email preview"
                sandbox=""
                // Show the sanitized HTML (unsupported tags and inline styles
                // are stripped before sending) so the preview reflects the
                // formatting subscribers will see. Note this preview does NOT
                // substitute merge tags and does NOT include the auto-appended
                // unsubscribe footer — both are applied per-recipient on send.
                srcDoc={sanitizeHtml(campaign.htmlBody)}
                className="h-80 w-full border-0"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Preview shows how your email will be formatted after unsupported
              tags and styles are removed. Merge tags appear as-is, and the
              unsubscribe footer is added automatically on send.
            </p>
          </CardContent>
        </Card>
      )}

      {recipients && recipients.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recipients</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Email</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Error</TableHead>
                  <TableHead>Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recipients.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{r.email}</TableCell>
                    <TableCell>
                      <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                    </TableCell>
                    <TableCell className="max-w-56 truncate text-muted-foreground">
                      {r.error ?? "—"}
                    </TableCell>
                    <TableCell>{formatDateTime(r.updatedAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
