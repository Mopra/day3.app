import { Clock } from "lucide-react";
import { StatusBadge } from "@/components/ui/status-badge";
import { campaignStatusLabel, campaignStatusTone, formatDateTime } from "@/lib/format";

// A campaign status badge that reads at a glance: draft / scheduled / sending /
// in-review / sent / failed each get their own tone (and scheduled/sending get an
// icon or a live dot), so a list of campaigns isn't a wall of identical grey.
// `scheduledAt`, when present on a scheduled campaign, is shown inline so the
// list answers "when does this go out?" without opening the row.
// Tones come from the shared STATUS_TONE_CLASS in ui/status-badge.tsx, so this
// badge, the automation badges and the enrollment badge cannot drift apart.

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
    <StatusBadge tone={tone} live={isSending} className={className}>
      {isScheduled && <Clock className="size-3" />}
      {isScheduled && scheduledAt
        ? `Sends ${formatDateTime(scheduledAt)}`
        : campaignStatusLabel(status)}
    </StatusBadge>
  );
}
