import { Clock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { campaignStatusLabel, campaignStatusTone, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

// A campaign status badge that reads at a glance: draft / scheduled / sending /
// in-review / sent / failed each get their own tone (and scheduled/sending get an
// icon or a live dot), so a list of campaigns isn't a wall of identical grey.
// `scheduledAt` — when present on a scheduled campaign — is shown inline so the
// list answers "when does this go out?" without opening the row.
// Tones are drawn from the brand palette rather than stock Tailwind hues, and
// each one means the same thing everywhere in the app: olive is "landed and
// healthy" (also the dashboard's normal status dot and the Delivered metric),
// caramel is "in flight", clay/destructive is "needs you".
const TONE_CLASS: Record<string, string> = {
  success: "border-transparent bg-olive text-background",
  info: "border-border bg-transparent text-foreground",
  progress: "border-transparent bg-caramel/15 text-caramel",
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
      {/* Breathes rather than radiating: `animate-ping`'s expanding ring is
          built to catch an eye once, but a send can sit in this state for
          twenty minutes on a second monitor. See `animate-live-dot`. */}
      {isSending && (
        <span
          className="inline-flex size-1.5 shrink-0 rounded-full bg-current animate-live-dot"
          aria-hidden
        />
      )}
      {isScheduled && scheduledAt
        ? `Sends ${formatDateTime(scheduledAt)}`
        : campaignStatusLabel(status)}
    </Badge>
  );
}
