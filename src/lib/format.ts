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
      return "destructive";
    default:
      return "outline";
  }
}

export function statusLabel(status: string): string {
  return status.replace(/_/g, " ");
}
