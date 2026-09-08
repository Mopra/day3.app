import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";
import {
  automationStatusLabel,
  automationStatusTone,
  enrollmentStatusLabel,
  enrollmentStatusTone,
  type CampaignBadgeTone,
} from "@/lib/format";
import { cn } from "@/lib/utils";

// The one tone map behind every status badge in the app. Tones are drawn from
// the brand palette rather than stock Tailwind hues, and each means the same
// thing everywhere: olive is "landed and healthy" (also the dashboard's normal
// status dot and the Delivered metric), caramel is "in flight", clay/destructive
// is "needs you", an outline recedes without disappearing. A campaign that has
// "Sent", an automation that is "Active" and an enrollment that "Completed" are
// therefore the same olive, by construction rather than by four copies agreeing.
export const STATUS_TONE_CLASS: Record<CampaignBadgeTone, string> = {
  success: "border-transparent bg-olive text-background",
  info: "border-border bg-transparent text-foreground",
  progress: "border-transparent bg-caramel/15 text-caramel",
  neutral: "bg-secondary text-secondary-foreground",
  destructive: "bg-destructive/10 text-destructive",
};

export function StatusBadge({
  tone,
  live = false,
  className,
  children,
}: {
  tone: CampaignBadgeTone;
  // Breathes rather than radiating: `animate-ping`'s expanding ring is built to
  // catch an eye once, but a send can sit in this state for twenty minutes on a
  // second monitor. See `animate-live-dot`.
  live?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <Badge className={cn(STATUS_TONE_CLASS[tone], className)}>
      {live && (
        <span
          className="inline-flex size-1.5 shrink-0 rounded-full bg-current animate-live-dot"
          aria-hidden
        />
      )}
      {children}
    </Badge>
  );
}

// An automation's lifecycle status (draft / active / paused / archived).
export function AutomationStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <StatusBadge tone={automationStatusTone(status)} className={className}>
      {automationStatusLabel(status)}
    </StatusBadge>
  );
}

// One person's status inside an automation. Active and sending get the live dot
// because they are the states that change on their own.
export function EnrollmentStatusBadge({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  return (
    <StatusBadge
      tone={enrollmentStatusTone(status)}
      live={status === "active" || status === "sending"}
      className={className}
    >
      {enrollmentStatusLabel(status)}
    </StatusBadge>
  );
}
