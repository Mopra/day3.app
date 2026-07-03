"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { BellIcon } from "lucide-react";
import { useApi } from "@/lib/api";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";

type Notification = {
  id: string;
  kind: string;
  title: string;
  body: string;
  ctaLabel: string | null;
  ctaHref: string | null;
  readAt: string | null;
  createdAt: string;
};

// Bottom-of-sidebar notification bell. Surfaces the account notifications written
// by services/notifications.ts (scheduled-send failures, capped signups, finished
// sends/imports) so things that happen while the tab is closed aren't invisible.
// Polls lightly; marks everything read when opened.
export function NotificationBell() {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);

  const load = useCallback(() => {
    api
      .get<{ notifications: Notification[]; unreadCount: number }>("/api/notifications")
      .then((res) => {
        setItems(res.notifications);
        setUnread(res.unreadCount);
      })
      .catch(() => {});
  }, [api]);

  useEffect(() => {
    load();
    // Refresh occasionally so a notification raised elsewhere (a cron sweep, a
    // completed send) shows up without a full reload.
    const t = setInterval(load, 60_000);
    return () => clearInterval(t);
  }, [load]);

  async function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next && unread > 0) {
      // Opening the panel is acknowledgement — clear the badge optimistically.
      setUnread(0);
      try {
        await api.post("/api/notifications", {});
        setItems((cur) => cur.map((n) => ({ ...n, readAt: n.readAt ?? new Date(0).toISOString() })));
      } catch {
        // Non-fatal; the count re-syncs on the next poll.
      }
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        aria-label={unread > 0 ? `Notifications (${unread} unread)` : "Notifications"}
        className="relative flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
      >
        <BellIcon className="size-4 shrink-0" />
        Notifications
        {unread > 0 && (
          <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-medium text-primary-foreground tabular-nums">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80 p-0">
        <div className="border-b border-border px-3 py-2.5">
          <p className="text-sm font-medium">Notifications</p>
        </div>
        {items.length === 0 ? (
          <div className="px-3 py-8 text-center text-sm text-muted-foreground">
            You&apos;re all caught up.
          </div>
        ) : (
          <ul className="max-h-96 divide-y divide-border overflow-auto">
            {items.map((n) => (
              <li
                key={n.id}
                className={cn("px-3 py-2.5", !n.readAt && "bg-primary/[0.04]")}
              >
                <p className="text-sm font-medium">{n.title}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{n.body}</p>
                <div className="mt-1 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-muted-foreground tabular-nums">
                    {formatDateTime(n.createdAt)}
                  </span>
                  {n.ctaHref && (
                    <Link
                      href={n.ctaHref}
                      onClick={() => setOpen(false)}
                      className="text-xs font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {n.ctaLabel ?? "Open"}
                    </Link>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  );
}
