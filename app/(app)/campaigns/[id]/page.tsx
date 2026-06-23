"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useUser } from "@clerk/nextjs";
import { toast } from "sonner";
import { CalendarClock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OrbitLoaderScreen } from "@/components/ui/orbit-loader";
import { LaunchStream, SendDots } from "@/components/ui/send-loader";
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
import { CampaignComposer, type CampaignFormValues } from "@/components/campaign-composer";
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

// Formats a Date as the value a <input type="datetime-local"> expects
// ("YYYY-MM-DDTHH:mm") in the user's local timezone.
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Numeric per-status keys only (excludes `total` and the `undeliverable` array).
const STAT_KEYS = [
  "pending",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "unsubscribed",
  "failed",
  "skipped",
] as const satisfies readonly (keyof CampaignStats)[];

// The send-in-progress hero, shown while the pipeline works (review → build
// recipients → sending). Copy and the live count follow the campaign status so
// the user sees momentum rather than a static "please wait".
function SendingBanner({
  status,
  stats,
}: {
  status: Campaign["status"];
  stats: CampaignStats | null;
}) {
  const copy: Record<string, { title: string; subtitle: string }> = {
    pending_review: {
      title: "Reviewing your campaign",
      subtitle: "Running a quick safety check before it goes out.",
    },
    approved: {
      title: "Approved — preparing to send",
      subtitle: "Getting everything ready.",
    },
    generating_recipients: {
      title: "Building your send list",
      subtitle: "Gathering the subscribers for this campaign.",
    },
    sending: {
      title: "Sending your campaign",
      subtitle:
        stats && stats.total > 0
          ? `${((stats.sent ?? 0) + (stats.delivered ?? 0)).toLocaleString()} of ${stats.total.toLocaleString()} sent · going out now`
          : "Your emails are going out now.",
    },
  };
  const { title, subtitle } = copy[status] ?? copy.sending;
  return (
    <div className="flex flex-col gap-4 rounded-xl border border-primary/20 bg-primary/5 p-5 sm:flex-row sm:items-center">
      <LaunchStream scale={0.8} />
      <div className="min-w-0">
        <h2 className="font-medium">{title}</h2>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );
}

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const { user } = useUser();
  const searchParams = useSearchParams();
  // Dev-only: force the send banner onto a real campaign page without sending,
  // e.g. /campaigns/<id>?send=sending. Ignored in production builds.
  const previewSend =
    process.env.NODE_ENV !== "production" ? searchParams.get("send") : null;
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [riskReview, setRiskReview] = useState<RiskReview | null>(null);
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");

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

  // Quiet autosave — same PATCH, but no toast or refetch so it doesn't disrupt
  // the user mid-edit.
  async function onAutosave(values: CampaignFormValues) {
    await api.patch(`/api/campaigns/${id}`, values);
  }

  // Open the schedule dialog seeded with the existing time, or a sensible
  // default an hour out.
  function openSchedule() {
    setScheduleAt(
      campaign?.scheduledAt
        ? toLocalInput(new Date(campaign.scheduledAt))
        : toLocalInput(new Date(Date.now() + 60 * 60 * 1000)),
    );
    setScheduleOpen(true);
  }

  async function submitSchedule() {
    const when = new Date(scheduleAt);
    if (Number.isNaN(when.getTime()) || when.getTime() < Date.now() + 60_000) {
      toast.error("Pick a time at least a minute from now");
      return;
    }
    setBusy(true);
    try {
      await api.post(`/api/campaigns/${id}/schedule`, { scheduledAt: when.toISOString() });
      toast.success("Send scheduled");
      setScheduleOpen(false);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't schedule");
    } finally {
      setBusy(false);
    }
  }

  if (!campaign) return <OrbitLoaderScreen />;

  const ownEmail = user?.primaryEmailAddress?.emailAddress;
  const submittable = campaign.status === "draft" || campaign.status === "approved";
  // Pre-flight: mirror the submit route's send gates so the user sees an
  // actionable message (with a fix link) instead of clicking into a raw error.
  const sendBlocked = submittable && onboarding && !onboarding.canSend ? onboarding : null;
  const blockFix = sendBlocked?.sendBlockedReason
    ? fixLinkFor(sendBlocked.sendBlockedReason)
    : null;

  const statusBadge = (
    <Badge variant={statusVariant(campaign.status)}>{statusLabel(campaign.status)}</Badge>
  );

  const actionButtons = (
    <>
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
          variant="outline"
          disabled={busy || !!sendBlocked}
          onClick={openSchedule}
        >
          <CalendarClock className="size-4" />
          Schedule
        </Button>
      )}
      {submittable && (
        <Button
          disabled={busy || !!sendBlocked}
          onClick={() => action("submit", undefined, "Campaign submitted")}
        >
          {busy || previewSend === "submitting" ? (
            <>
              <SendDots />
              Sending…
            </>
          ) : (
            "Submit & send"
          )}
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
    </>
  );

  // Drafts get an editable title inside the composer, so the status badge and
  // actions move into the composer's title row. Other statuses keep the static
  // page heading.
  const isDraft = campaign.status === "draft";

  return (
    <div className="space-y-6">
      {!isDraft && (
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">{campaign.name}</h1>
            {statusBadge}
          </div>
          <div className="flex gap-2">{actionButtons}</div>
        </div>
      )}

      {(inFlight || previewSend) && (
        <SendingBanner
          status={(previewSend as Campaign["status"]) ?? campaign.status}
          stats={stats}
        />
      )}

      {campaign.status === "scheduled" && (
        <div className="flex flex-col gap-3 rounded-xl border border-border bg-muted/30 p-5 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <CalendarClock className="size-5 shrink-0 text-muted-foreground" />
            <div className="min-w-0">
              <h2 className="font-medium">Scheduled to send</h2>
              <p className="text-sm text-muted-foreground">
                Goes out {formatDateTime(campaign.scheduledAt)} — sending starts within ~15
                minutes of that time.
              </p>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button variant="outline" size="sm" disabled={busy} onClick={openSchedule}>
              Reschedule
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => action("unschedule", undefined, "Moved back to draft")}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}

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
            <p>
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
            </p>
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

      {stats && stats.undeliverable && stats.undeliverable.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Didn&apos;t receive</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">
              Suppressed recipients were skipped on purpose (unsubscribed,
              bounced, or complained before). Failed recipients hit a hard send
              error.
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Type</TableHead>
                  <TableHead>Reason</TableHead>
                  <TableHead className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.undeliverable.map((u) => (
                  <TableRow key={`${u.status}:${u.reason}`}>
                    <TableCell>
                      <Badge variant={u.status === "skipped" ? "outline" : "destructive"}>
                        {u.status === "skipped" ? "Suppressed" : "Failed"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{u.reason}</TableCell>
                    <TableCell className="text-right font-medium">{u.count}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {isDraft ? (
        <CampaignComposer
          initial={campaign}
          onSave={onSave}
          onAutosave={onAutosave}
          submitLabel="Save draft"
          titleBadge={statusBadge}
          titleActions={actionButtons}
        />
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

      <Dialog open={scheduleOpen} onOpenChange={setScheduleOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Schedule send</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Pick when this campaign should go out. We&apos;ll run the safety review and start
              sending at that time (within ~15 minutes).
            </p>
            <div className="space-y-1.5">
              <label htmlFor="scheduleAt" className="text-sm font-medium">
                Date &amp; time
              </label>
              <input
                id="scheduleAt"
                type="datetime-local"
                value={scheduleAt}
                min={toLocalInput(new Date())}
                onChange={(e) => setScheduleAt(e.target.value)}
                className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
              />
              <p className="text-xs text-muted-foreground">
                Uses your computer&apos;s timezone.
              </p>
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" disabled={busy} onClick={() => setScheduleOpen(false)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={submitSchedule}>
                {busy ? "Scheduling…" : "Schedule send"}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
