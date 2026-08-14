"use client";

import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { cn } from "@/lib/utils";

// A page-top notice that minimizes instead of dismissing. The messages above the
// campaign builder ("can't be sent yet", "missing personalization", "paused") carry
// things the user needs at the moment they hit Send, so none of them are
// dismissible — but three stacked alerts push the email itself below the fold.
// Collapsing leaves the title on screen and folds the detail away; one click brings
// it back. Nothing is ever hidden outright.
//
// The choice is remembered per notice *kind*, not per campaign: someone who has
// minimized "missing personalization" once means it for their next draft too, and
// there's nothing to lose by it — a notice only renders while its condition still
// holds, and its title stays visible either way.
const STORAGE_PREFIX = "day3:notice:";

function storedCollapsed(key: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + key) === "1";
  } catch {
    // localStorage blocked (private mode) — fall back to expanded.
    return false;
  }
}

export function CollapsibleNotice({
  noticeKey,
  title,
  variant,
  className,
  children,
}: {
  // Stable id for remembering the collapsed state. Kind, not instance — see above.
  noticeKey: string;
  title: ReactNode;
  variant?: "default" | "destructive";
  className?: string;
  children: ReactNode;
}) {
  // These notices mount only after the campaign has loaded on the client, so
  // reading localStorage in the initializer can't desync a server-rendered tree.
  const [collapsed, setCollapsed] = useState(() => storedCollapsed(noticeKey));
  const bodyId = useId();

  function toggle() {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem(STORAGE_PREFIX + noticeKey, next ? "1" : "0");
      } catch {
        // Not remembering it is fine; the toggle still works for this session.
      }
      return next;
    });
  }

  return (
    <Alert variant={variant} className={className}>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={!collapsed}
        aria-controls={bodyId}
        className="group col-start-2 flex w-full items-center gap-3 rounded text-left focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none"
      >
        <span className="min-w-0 flex-1 font-medium tracking-tight">{title}</span>
        {/* Label + chevron are one control, so they sit closer to each other than
            to the title. Dimmed with opacity rather than a muted colour, so the
            affordance reads the same on the destructive variant (red text). */}
        <span className="flex shrink-0 items-center gap-1 text-xs opacity-60 transition-opacity group-hover:opacity-100">
          {collapsed ? "Show" : "Hide"}
          <ChevronDown
            className={cn("size-3.5 transition-transform", !collapsed && "rotate-180")}
          />
        </span>
      </button>
      {!collapsed && (
        <AlertDescription id={bodyId} className="pt-1">
          {children}
        </AlertDescription>
      )}
    </Alert>
  );
}
