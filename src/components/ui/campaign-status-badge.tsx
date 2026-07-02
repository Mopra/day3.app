import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { campaignStatusLabel, campaignStatusTone, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

// A campaign status badge that reads at a glance: draft / scheduled / sending /
// in-review / sent / failed each get their own tone (and scheduled/sending get an
// icon or a live dot), so a list of campaigns isn't a wall of identical grey.
// `scheduledAt` — when present on a scheduled campaign — is shown inline so the
// list answers "when does this go out?" without opening the row.
const TONE_CLASS: Record<string, string> = {
  success: "bg-primary text-primary-foreground",
  info: "border-border bg-transparent text-foreground",
  progress:
    "border-transparent bg-blue-500/10 text-blue-600 dark:bg-blue-400/15 dark:text-blue-300",
  neutral: "bg-secondary text-secondary-foreground",
  destructive: "bg-destructive/10 text-destructive",
};

export function CampaignStatusBadge({
  status,
  scheduledAt,
  className,
}: {
  status: string;
  scheduledAt?: string | null;
  className?: string;
}) {
  const tone = campaignStatusTone(status);
  const isSending = status === "sending" || status === "generating_recipients";
  const isScheduled = status === "scheduled";

  return (
    <Badge className={cn(TONE_CLASS[tone], className)}>
      {isScheduled && <Clock className="size-3" />}
      {isSending && (
        <span className="relative flex size-1.5" aria-hidden>
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-75" />
          <span className="relative inline-flex size-1.5 rounded-full bg-current" />
        </span>
      )}
      {isScheduled && scheduledAt
        ? `Sends ${formatDateTime(scheduledAt)}`
        : campaignStatusLabel(status)}
    </Badge>
  );
}
