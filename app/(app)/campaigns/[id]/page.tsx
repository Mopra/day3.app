"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { CalendarClock, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { OrbitLoader, OrbitLoaderScreen } from "@/components/ui/orbit-loader";
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
import {
  ListCount,
  ListFilter,
  ListNoResults,
  ListSkeleton,
  ListToolbar,
  RowActions,
} from "@/components/ui/data-list";
import { MenuItem } from "@/components/ui/menu";
import { useApi } from "@/lib/api";
import {
  campaignStatusLabel,
  formatDateTime,
  recipientStatusLabel,
  statusVariant,
} from "@/lib/format";
import { CampaignStatusBadge } from "@/components/ui/campaign-status-badge";
import { sanitizeHtml } from "@/services/render";
import { CampaignComposer, type CampaignFormValues } from "@/components/campaign-composer";
import { SendTestButton } from "@/components/send-test-button";
import type {
  Campaign,
  CampaignStats,
  OnboardingState,
  PersonalizationGap,
  Recipient,
  RiskReview,
} from "@/lib/types";

// Turns a personalization gap into a one-line, sender-facing sentence. With a
// fallback the slice still reads fine (just generic); without one it renders blank.
function personalizationMessage(g: PersonalizationGap): string {
  const label = g.field === "first_name" ? "first name" : "last name";
  const pct = Math.round((g.missing / g.total) * 100);
  const who = `${g.missing.toLocaleString()} of ${g.total.toLocaleString()} recipients (${pct}%) have no ${label}`;
  return g.fallback
    ? `${who} — they'll see "${g.fallback}" instead.`
    : `${who} — their ${label} will appear blank. Add a fallback like {{${g.field}|there}} so it reads well.`;
}

// The review's fix-it steps, parsed from the stored JSON array. Defensive: a
// malformed value renders as "no guidance" rather than crashing the page.
function riskGuidance(review: RiskReview | null): string[] {
  if (!review?.guidanceJson) return [];
  try {
    const parsed: unknown = JSON.parse(review.guidanceJson);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string") : [];
  } catch {
    return [];
  }
}

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

// The payoff. Sending is the emotional peak of the product; when a campaign
// reaches "sent" the page shouldn't just turn into a table of numbers. A warm
// success banner names the win and points the user at the two things they'll
// want next — engagement (Metrics) and per-recipient troubleshooting (Activity).
function SentBanner({
  campaignId,
  stats,
  sentAt,
}: {
  campaignId: string;
  stats: CampaignStats;
  sentAt: string | null;
}) {
  const reached = (stats.sent ?? 0) + (stats.delivered ?? 0);
  return (
    <div className="overflow-hidden rounded-xl border border-primary/20 bg-primary/5 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-primary/10 text-2xl">
          🎉
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="font-medium">Your campaign is out!</h2>
          <p className="text-sm text-muted-foreground">
            {reached > 0
              ? `Sent to ${reached.toLocaleString()} ${reached === 1 ? "subscriber" : "subscribers"}`
              : "Your emails are on their way"}
            {sentAt ? ` · ${formatDateTime(sentAt)}` : ""}.
          </p>
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
          <Button size="sm" render={<Link href={`/metrics?campaign=${campaignId}`} />}>
            See opens &amp; clicks
          </Button>
          <Button
            variant="outline"
            size="sm"
            render={<Link href={`/activity?campaignId=${campaignId}`} />}
          >
            Troubleshoot a recipient
          </Button>
        </div>
      </div>
    </div>
  );
}

export default function CampaignDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const router = useRouter();
  const searchParams = useSearchParams();
  // Dev-only: force the send banner onto a real campaign page without sending,
  // e.g. /campaigns/<id>?send=sending. Ignored in production builds.
  const previewSend =
    process.env.NODE_ENV !== "production" ? searchParams.get("send") : null;
  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [stats, setStats] = useState<CampaignStats | null>(null);
  const [riskReview, setRiskReview] = useState<RiskReview | null>(null);
  const [personalization, setPersonalization] = useState<PersonalizationGap[]>([]);
  const [recipients, setRecipients] = useState<Recipient[] | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [busy, setBusy] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [submitOpen, setSubmitOpen] = useState(false);
  // Audience name + subscribed count for the send-confirmation dialog. Fetched
  // when the dialog opens (recipients aren't generated until after submit, so
  // we can't use `stats`); null = still loading.
  const [audienceSummary, setAudienceSummary] = useState<{
    name: string;
    subscribed: number;
  } | null>(null);
  const [recipientStatus, setRecipientStatus] = useState("all");
  const [loadingMoreRec, setLoadingMoreRec] = useState(false);

  const load = useCallback(() => {
    api
      .get<{
        campaign: Campaign;
        stats: CampaignStats;
        riskReview: RiskReview | null;
        personalization: PersonalizationGap[];
      }>(`/api/campaigns/${id}`)
      .then((res) => {
        setCampaign(res.campaign);
        setStats(res.stats);
        setRiskReview(res.riskReview);
        setPersonalization(res.personalization ?? []);
      })
      .catch((err) => toast.error(err.message));
    api
      .get<{ onboarding: OnboardingState }>("/api/account/onboarding")
      .then((res) => setOnboarding(res.onboarding))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(load, [load]);

  // Recipients are their own filterable, paginated list. The endpoint caps a
  // request at 100, so we page in 50s; per-status totals come from `stats`.
  const REC_PAGE = 50;
  const recipientsUrl = useCallback(
    (offset: number) => {
      const params = new URLSearchParams({ limit: String(REC_PAGE), offset: String(offset) });
      if (recipientStatus !== "all") params.set("status", recipientStatus);
      return `/api/campaigns/${id}/recipients?${params}`;
    },
    [id, recipientStatus],
  );

  const loadRecipients = useCallback(() => {
    api
      .get<{ recipients: Recipient[] }>(recipientsUrl(0))
      .then((res) => setRecipients(res.recipients))
      .catch(() => {});
  }, [api, recipientsUrl]);

  useEffect(loadRecipients, [loadRecipients]);

  async function loadMoreRecipients() {
    if (!recipients || loadingMoreRec) return;
    setLoadingMoreRec(true);
    try {
      const res = await api.get<{ recipients: Recipient[] }>(recipientsUrl(recipients.length));
      setRecipients((cur) => [...(cur ?? []), ...res.recipients]);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't load more");
    } finally {
      setLoadingMoreRec(false);
    }
  }

  // Live-update while the pipeline is working.
  const inFlight =
    campaign &&
    ["pending_review", "approved", "generating_recipients", "sending"].includes(campaign.status);
  useEffect(() => {
    if (!inFlight) return;
    const t = setInterval(() => {
      load();
      loadRecipients();
    }, 2500);
    return () => clearInterval(t);
  }, [inFlight, load, loadRecipients]);

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

  // Autosave is the only save path — a quiet PATCH with no toast or refetch so it
  // doesn't disrupt the user mid-edit.
  async function onAutosave(values: CampaignFormValues) {
    await api.patch(`/api/campaigns/${id}`, values);
  }

  // Open the send-confirmation dialog and fetch the audience name + subscribed
  // count so the user confirms exactly who they're about to email. Sending is
  // irreversible, so this gate is deliberate — never fire "submit" from a click.
  function openSubmit() {
    setAudienceSummary(null);
    setSubmitOpen(true);
    if (!campaign?.audienceId) return;
    api
      .get<{ audience: { name: string }; counts: Record<string, number> }>(
        `/api/audiences/${campaign.audienceId}`,
      )
      .then((res) =>
        setAudienceSummary({
          name: res.audience.name,
          subscribed: res.counts.subscribed ?? 0,
        }),
      )
      .catch(() => {});
  }

  async function confirmSubmit() {
    setSubmitOpen(false);
    await action("submit", undefined, "Campaign submitted");
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

  // A blocked campaign can't be edited or resubmitted — the way forward is a
  // fresh draft copy with the flagged content fixed.
  const [duplicating, setDuplicating] = useState(false);
  async function duplicateAndFix() {
    setDuplicating(true);
    try {
      const res = await api.post<{ id: string }>(`/api/campaigns/${id}/duplicate`);
      toast.success("Draft copy created — make the changes there and send that");
      router.push(`/campaigns/${res.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create a copy");
      setDuplicating(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await api.del(`/api/campaigns/${id}`);
      toast.success("Campaign deleted");
      router.push("/campaigns");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete campaign");
      setDeleting(false);
    }
  }

  if (!campaign) return <OrbitLoaderScreen />;

  // Mid-send campaigns can't be deleted — pause first (mirrors the API guard).
  const deletable =
    campaign.status !== "sending" && campaign.status !== "generating_recipients";
  const submittable = campaign.status === "draft" || campaign.status === "approved";
  // Pre-flight: mirror the submit route's send gates so the user sees an
  // actionable message (with a fix link) instead of clicking into a raw error.
  const sendBlocked = submittable && onboarding && !onboarding.canSend ? onboarding : null;
  const blockFix = sendBlocked?.sendBlockedReason
    ? fixLinkFor(sendBlocked.sendBlockedReason)
    : null;

  const statusBadge = (
    <CampaignStatusBadge status={campaign.status} scheduledAt={campaign.scheduledAt} />
  );

  const actionButtons = (
    <>
      <SendTestButton campaignId={id} disabled={busy} />
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
          onClick={openSubmit}
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
      {deletable && (
        <RowActions>
          <MenuItem
            variant="destructive"
            disabled={busy}
            onClick={() => setDeleteOpen(true)}
          >
            <Trash2 />
            Delete
          </MenuItem>
        </RowActions>
      )}
    </>
  );

  // Drafts get an editable title inside the composer, so the status badge and
  // actions move into the composer's title row. Other statuses keep the static
  // page heading.
  const isDraft = campaign.status === "draft";

  // Recipient filter options follow the per-status counts in `stats`, so we only
  // surface statuses that actually have rows; totals come from the same source.
  const recipientFilterTotal =
    recipientStatus === "all"
      ? stats?.total ?? 0
      : ((stats?.[recipientStatus as keyof CampaignStats] as number | undefined) ?? 0);
  const recipientStatusOptions = [
    { value: "all", label: "All statuses" },
    ...STAT_KEYS.filter((k) => (stats?.[k] ?? 0) > 0).map((k) => ({
      value: k,
      label: recipientStatusLabel(k),
    })),
  ];
  const recShown = recipients?.length ?? 0;
  const recHasMore = recShown < recipientFilterTotal;

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

      {campaign.status === "sent" && stats && stats.total > 0 && (
        <SentBanner campaignId={id} stats={stats} sentAt={campaign.sentAt} />
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
          <AlertTitle>
            {campaign.status === "draft"
              ? "Your scheduled send didn't go out"
              : campaign.status === "paused"
                ? "Sending is paused"
                : campaignStatusLabel(campaign.status)}
          </AlertTitle>
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

      {submittable && personalization.length > 0 && (
        <Alert>
          <AlertTitle>Some recipients are missing personalization</AlertTitle>
          <AlertDescription>
            <ul className="list-disc space-y-1 pl-4">
              {personalization.map((g) => (
                <li key={g.field}>{personalizationMessage(g)}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      {campaign.status === "blocked" && (
        <Alert variant="destructive">
          <AlertTitle>This campaign didn&apos;t pass the safety review</AlertTitle>
          <AlertDescription>
            <div className="space-y-3">
              <p>
                Our automated review flagged content that mailbox providers punish with
                spam-folder placement — and that damages deliverability for every email
                you send after this one. Here&apos;s what to change:
              </p>
              {riskGuidance(riskReview).length > 0 ? (
                <ul className="list-disc space-y-1 pl-4">
                  {riskGuidance(riskReview).map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              ) : (
                riskReview && <p>{riskReview.summary}</p>
              )}
              <p>
                A blocked campaign can&apos;t be edited or sent again — create a copy,
                make the changes there, and send that instead. Flagged campaigns also get
                a second look from our team, so a genuine false alarm can be released
                without changes.
              </p>
              <Button
                variant="outline"
                size="sm"
                disabled={duplicating}
                onClick={duplicateAndFix}
              >
                {duplicating && <OrbitLoader size={16} />}
                Duplicate &amp; fix
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      )}

      {riskReview && campaign.status !== "blocked" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Safety review</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="flex flex-wrap items-center gap-3">
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
            </div>
            {riskGuidance(riskReview).length > 0 && (
              <div className="space-y-1">
                <p className="font-medium">Suggestions for your next send</p>
                <ul className="list-disc space-y-1 pl-4 text-muted-foreground">
                  {riskGuidance(riskReview).map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </div>
            )}
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
                    <div className="text-xs text-muted-foreground">{recipientStatusLabel(key)}</div>
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
          onAutosave={onAutosave}
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

      {stats && stats.total > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recipients</CardTitle>
          </CardHeader>
          <CardContent>
            <ListToolbar className="mb-4">
              <ListFilter
                value={recipientStatus}
                onChange={setRecipientStatus}
                options={recipientStatusOptions}
                ariaLabel="Filter recipients by status"
              />
              <ListCount
                shown={recShown}
                total={recipientFilterTotal}
                noun="recipient"
                className="ml-auto"
              />
            </ListToolbar>
            {recipients === null ? (
              <ListSkeleton />
            ) : recipients.length === 0 ? (
              <ListNoResults
                onClear={() => setRecipientStatus("all")}
                message="No recipients match this status."
              />
            ) : (
              <>
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
                          <Badge variant={statusVariant(r.status)}>
                            {recipientStatusLabel(r.status)}
                          </Badge>
                        </TableCell>
                        <TableCell className="max-w-56 truncate text-muted-foreground">
                          {r.error ?? "—"}
                        </TableCell>
                        <TableCell className="text-muted-foreground">
                          {formatDateTime(r.updatedAt)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                {recHasMore && (
                  <div className="flex justify-center pt-4">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadMoreRecipients}
                      disabled={loadingMoreRec}
                    >
                      {loadingMoreRec && <OrbitLoader size={16} />}
                      Load more
                      <span className="text-muted-foreground tabular-nums">
                        ({(recipientFilterTotal - recShown).toLocaleString()} more)
                      </span>
                    </Button>
                  </div>
                )}
              </>
            )}
          </CardContent>
        </Card>
      )}

      <Dialog open={submitOpen} onOpenChange={setSubmitOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send this campaign?</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              You&apos;re about to email{" "}
              <strong className="text-foreground">
                {audienceSummary
                  ? `${audienceSummary.subscribed.toLocaleString()} ${
                      audienceSummary.subscribed === 1 ? "subscriber" : "subscribers"
                    }`
                  : "your audience"}
              </strong>
              {audienceSummary ? (
                <>
                  {" "}
                  in <strong className="text-foreground">{audienceSummary.name}</strong>
                </>
              ) : null}
              . After a quick safety review it sends right away — this can&apos;t be undone.
            </p>
            <dl className="space-y-2 rounded-lg border border-border bg-muted/30 p-3 text-sm">
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted-foreground">From</dt>
                <dd className="min-w-0 break-words font-medium">
                  {campaign.fromName} &lt;{campaign.fromEmail}&gt;
                </dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-16 shrink-0 text-muted-foreground">Subject</dt>
                <dd className="min-w-0 break-words font-medium">{campaign.subject}</dd>
              </div>
            </dl>
            <div className="flex justify-end gap-2 pt-1">
              <Button variant="ghost" disabled={busy} onClick={() => setSubmitOpen(false)}>
                Cancel
              </Button>
              <Button disabled={busy} onClick={confirmSubmit}>
                {busy ? (
                  <>
                    <SendDots />
                    Sending…
                  </>
                ) : audienceSummary ? (
                  `Send to ${audienceSummary.subscribed.toLocaleString()}`
                ) : (
                  "Send now"
                )}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

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
                className="h-9 w-full rounded-lg border border-input bg-transparent px-2.5 text-sm outline-none [color-scheme:light] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 dark:[color-scheme:dark]"
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

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete "${campaign.name}"?`}
        description="This permanently removes the campaign and its recipient records. If it's already been sent, it's removed from your history too. This can't be undone."
        confirmLabel="Delete campaign"
        busy={deleting}
        onConfirm={remove}
      />
    </div>
  );
}
