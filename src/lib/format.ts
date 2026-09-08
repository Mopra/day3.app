export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// Humanizes a remaining duration as "2h 14m" / "14m" — used for the subtle "AI
// assist resets in …" copy. Rounds up so a 1s remainder still reads "1m".
export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(s / 3600);
  const minutes = Math.ceil((s - hours * 3600) / 60);
  // ceil can roll minutes to 60 (e.g. 1h 59m 30s) — carry into the hour.
  const carriedHours = hours + (minutes === 60 ? 1 : 0);
  const carriedMinutes = minutes === 60 ? 0 : minutes;
  if (carriedHours > 0) {
    return carriedMinutes > 0 ? `${carriedHours}h ${carriedMinutes}m` : `${carriedHours}h`;
  }
  if (carriedMinutes > 0) return `${carriedMinutes}m`;
  return "under a minute";
}

// Badge variants for entity statuses across the app.
export function statusVariant(
  status: string,
): "default" | "secondary" | "destructive" | "outline" {
  switch (status) {
    case "sent":
    case "delivered":
    case "completed":
    case "verified":
    case "subscribed":
    case "active":
    case "approved":
      return "default";
    case "draft":
    case "scheduled":
    case "pending":
    case "pending_review":
    case "processing":
    case "generating_recipients":
    case "sending":
      return "secondary";
    case "blocked":
    case "failed":
    case "bounced":
    case "complained":
    case "paused":
    case "past_due":
      return "destructive";
    default:
      return "outline";
  }
}

export function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}

// User-facing labels for campaign lifecycle statuses. The raw enum values are
// internal ("generating_recipients", "pending_review"); a founder should read
// plain language. Falls back to the underscore-strip for anything unmapped.
const CAMPAIGN_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  scheduled: "Scheduled",
  pending_review: "In review",
  approved: "Approved",
  generating_recipients: "Preparing recipients",
  sending: "Sending",
  sent: "Sent",
  paused: "Paused",
  blocked: "Blocked",
  failed: "Failed",
};

export function campaignStatusLabel(status: string): string {
  return CAMPAIGN_STATUS_LABELS[status] ?? cap(statusLabel(status));
}

// User-facing labels for per-recipient delivery statuses (stats tiles, tables).
const RECIPIENT_STATUS_LABELS: Record<string, string> = {
  pending: "Queued",
  sending: "Sending",
  sent: "Sent",
  delivered: "Delivered",
  bounced: "Bounced",
  complained: "Marked as spam",
  unsubscribed: "Unsubscribed",
  failed: "Couldn't deliver",
  skipped: "Skipped",
};

export function recipientStatusLabel(status: string): string {
  return RECIPIENT_STATUS_LABELS[status] ?? cap(statusLabel(status));
}

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Badge tone for a campaign status. Distinct from the generic statusVariant so a
// list of campaigns doesn't render draft / scheduled / sending / in-review as the
// same flat grey. "info" is a live/in-progress accent; "success" is a terminal win.
export type CampaignBadgeTone = "success" | "info" | "progress" | "neutral" | "destructive";

export function campaignStatusTone(status: string): CampaignBadgeTone {
  switch (status) {
    case "sent":
      return "success";
    case "scheduled":
      return "info";
    case "sending":
    case "generating_recipients":
    case "pending_review":
    case "approved":
      return "progress";
    case "paused":
    case "blocked":
    case "failed":
      return "destructive";
    default:
      return "neutral"; // draft
  }
}

// Automation lifecycle statuses and the enrollment statuses of the people inside
// one. Kept beside the campaign labels so the two lists read as one product:
// "Active" means the same thing on both.
const AUTOMATION_STATUS_LABELS: Record<string, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};

export function automationStatusLabel(status: string): string {
  return AUTOMATION_STATUS_LABELS[status] ?? cap(statusLabel(status));
}

// Same tone vocabulary as campaignStatusTone: olive for "running and healthy",
// clay for "mail is not flowing and you did that", plain grey for a draft, an
// outline for the archive so it recedes without disappearing.
export function automationStatusTone(status: string): CampaignBadgeTone {
  switch (status) {
    case "active":
      return "success";
    case "paused":
      return "destructive";
    case "archived":
      return "info";
    default:
      return "neutral"; // draft
  }
}

// An enrollment is one person's trip through an automation. "active" covers both
// running and sleeping on a wait, which to the reader is simply "in progress".
const ENROLLMENT_STATUS_LABELS: Record<string, string> = {
  active: "In progress",
  sending: "Sending",
  completed: "Completed",
  exited: "Exited",
  failed: "Failed",
};

export function enrollmentStatusLabel(status: string): string {
  return ENROLLMENT_STATUS_LABELS[status] ?? cap(statusLabel(status));
}

export function enrollmentStatusTone(status: string): CampaignBadgeTone {
  switch (status) {
    case "active":
    case "sending":
      return "progress";
    case "completed":
      return "success";
    case "failed":
      return "destructive";
    default:
      return "neutral"; // exited
  }
}
