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
