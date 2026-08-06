"use client";

// The campaign send-actions cluster — "Send test to me", Schedule, Submit & send,
// Pause/Resume, and Delete — plus the confirm/schedule dialogs they open. Pulled
// out of the campaign detail page so the brand-new-campaign page (`/campaigns/new`)
// can show the *same* live actions the moment its draft is created, without
// remounting the composer mid-edit. Self-contained: it loads the campaign and the
// org's onboarding/send-gates by id, so a caller only needs to hand it an id.
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { CalendarClock, Check, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SendDots } from "@/components/ui/send-loader";
import { SendTestButton } from "@/components/send-test-button";
import { RowActions } from "@/components/ui/data-list";
import { MenuItem } from "@/components/ui/menu";
import { useApi } from "@/lib/api";
import type { Campaign, OnboardingState } from "@/lib/types";

// Maps a send-blocking condition to the page that fixes it, so the user gets a
// link rather than a dead-end message. (Mirrors the campaign detail page.)
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
  if (r.includes("address") || r.includes("settings")) {
    return { href: "/settings", label: "Add your address" };
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

export function CampaignActions({
  campaignId,
  onChanged,
  onSent,
}: {
  campaignId: string;
  // Called after any action that mutates the campaign, so a parent that also
  // renders the campaign (status badge, banners, stats) can refresh.
  onChanged?: () => void;
  // Called after a successful submit or schedule. The new-campaign page uses this
  // to navigate to the campaign's own page, where the live send/status view lives.
  onSent?: () => void;
}) {
  const api = useApi();
  const router = useRouter();

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [onboarding, setOnboarding] = useState<OnboardingState | null>(null);
  const [busy, setBusy] = useState(false);

  const [submitOpen, setSubmitOpen] = useState(false);
  const [audienceSummary, setAudienceSummary] = useState<{
    name: string;
    subscribed: number;
  } | null>(null);
  // How many people a sandbox (free-tier) send would actually reach — teammates
  // in the audience, not the whole audience. null = not a sandbox account.
  const [sandboxRecipients, setSandboxRecipients] = useState<number | null>(null);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [scheduleAt, setScheduleAt] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Load (and reload) the campaign + the org's send-gates. Kept self-contained so
  // both the detail page and the just-created draft on /campaigns/new can drop this
  // in with only an id.
  const load = useCallback(() => {
    api
      .get<{ campaign: Campaign; sandboxRecipients: number | null }>(
        `/api/campaigns/${campaignId}`,
      )
      .then((res) => {
        setCampaign(res.campaign);
        setSandboxRecipients(res.sandboxRecipients ?? null);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : "Couldn't load campaign"));
    api
      .get<{ onboarding: OnboardingState }>("/api/account/onboarding")
      .then((res) => setOnboarding(res.onboarding))
      .catch(() => {});
  }, [api, campaignId]);

  useEffect(load, [load]);

  async function action(path: string, body?: unknown, success?: string) {
    setBusy(true);
    try {
      await api.post(`/api/campaigns/${campaignId}/${path}`, body);
      if (success) toast.success(success);
      load();
      onChanged?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
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
    onSent?.();
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
      await api.post(`/api/campaigns/${campaignId}/schedule`, { scheduledAt: when.toISOString() });
      toast.success("Send scheduled");
      setScheduleOpen(false);
      load();
      onChanged?.();
      onSent?.();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't schedule");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    setDeleting(true);
    try {
      await api.del(`/api/campaigns/${campaignId}`);
      toast.success("Campaign deleted");
      router.push("/campaigns");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete campaign");
      setDeleting(false);
    }
  }

  // Until the campaign loads we render nothing — it's created/fetched in a blink,
  // and a half-built action bar would be worse than a brief absence.
  if (!campaign) return null;

  const deletable =
    campaign.status !== "sending" && campaign.status !== "generating_recipients";
  const submittable = campaign.status === "draft" || campaign.status === "approved";
  // Mirror the submit route's send gates so the user sees a disabled control with
  // an explanation rather than clicking into a raw error.
  const sendBlocked = submittable && onboarding && !onboarding.canSend ? onboarding : null;
  const blockTitle = sendBlocked?.sendBlockedReason ?? undefined;
  const blockFix = sendBlocked?.sendBlockedReason
    ? fixLinkFor(sendBlocked.sendBlockedReason)
    : null;

  return (
    <>
      <SendTestButton campaignId={campaignId} disabled={busy} />
      {submittable && (
        <Button
          variant="outline"
          disabled={busy || !!sendBlocked}
          title={blockTitle}
          onClick={openSchedule}
        >
          <CalendarClock className="size-4" />
          Schedule
        </Button>
      )}
      {submittable && (
        <Button disabled={busy || !!sendBlocked} title={blockTitle} onClick={openSubmit}>
          {busy ? (
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
          <MenuItem variant="destructive" disabled={busy} onClick={() => setDeleteOpen(true)}>
            <Trash2 />
            Delete
          </MenuItem>
        </RowActions>
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
                {sandboxRecipients !== null
                  ? `${sandboxRecipients.toLocaleString()} ${
                      sandboxRecipients === 1 ? "teammate" : "teammates"
                    }`
                  : audienceSummary
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
            {/* Mirrors the campaign detail page's dialog: on the free tier the
                audience count isn't who receives it, so name the real reach. */}
            {sandboxRecipients !== null && (
              <p className="text-sm text-muted-foreground">
                Sandbox mode — only members of your organization receive this send, even if the
                audience is larger.
              </p>
            )}
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
            {/* A quick green "everything's ready" reassurance at the point of no
                return — the button is only enabled once these pass, so this is
                confidence, not a gate. */}
            {onboarding && (
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                {[
                  { ok: onboarding.hasVerifiedDomain, label: "Verified sending domain" },
                  { ok: onboarding.hasMailingAddress, label: "Business address on file" },
                  { ok: onboarding.hasSubscribers, label: "Audience has subscribers" },
                ].map((c) => (
                  <li key={c.label} className="flex items-center gap-2">
                    <Check className="size-4 shrink-0 text-emerald-600" />
                    {c.label}
                  </li>
                ))}
              </ul>
            )}
            {blockFix && (
              <p className="text-sm text-muted-foreground">
                <Link href={blockFix.href} className="font-medium underline underline-offset-4">
                  {blockFix.label}
                </Link>
              </p>
            )}
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
                ) : sandboxRecipients !== null ? (
                  `Send to ${sandboxRecipients.toLocaleString()}`
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
    </>
  );
}
