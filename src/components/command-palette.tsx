"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  Activity,
  BarChart3,
  Globe,
  KeyRound,
  LayoutGrid,
  Mail,
  Plus,
  Search,
  Settings,
  Users,
  AtSign,
  FileInput,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Command = {
  label: string;
  hint?: string;
  icon: LucideIcon;
  href: string;
  keywords?: string;
};

// A Cmd/Ctrl+K command palette for fast navigation and the common "create"
// actions. The app is keyboard-friendly enough that not having one was felt.
// Self-contained: mounted once in the app shell, listens for the shortcut, and
// navigates on selection. No backend.
const COMMANDS: Command[] = [
  { label: "New campaign", hint: "Create", icon: Plus, href: "/campaigns/new", keywords: "compose write email draft" },
  { label: "Campaigns", icon: Mail, href: "/campaigns" },
  { label: "Audiences", icon: Users, href: "/audiences", keywords: "subscribers list contacts" },
  { label: "Import subscribers", hint: "Audiences", icon: FileInput, href: "/audiences", keywords: "csv upload" },
  { label: "Sending domains", icon: Globe, href: "/domains", keywords: "dns dkim verify" },
  { label: "Senders", icon: AtSign, href: "/senders", keywords: "from identity" },
  { label: "Signup forms", icon: FileInput, href: "/forms", keywords: "embed hosted" },
  { label: "Metrics", icon: BarChart3, href: "/metrics", keywords: "opens clicks deliverability" },
  { label: "Activity", icon: Activity, href: "/activity", keywords: "events log troubleshoot" },
  { label: "Dashboard", icon: LayoutGrid, href: "/dashboard", keywords: "home overview" },
  { label: "Billing", icon: BarChart3, href: "/billing", keywords: "plan upgrade subscription" },
  { label: "API keys", icon: KeyRound, href: "/api-keys", keywords: "api rest developers integrate migrate import token bearer docs" },
  { label: "Settings", icon: Settings, href: "/settings", keywords: "address organization" },
];

export function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Global shortcut. Cmd+K (mac) / Ctrl+K (win/linux).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reset the query/selection each time it opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return COMMANDS;
    return COMMANDS.filter((c) =>
      `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(q),
    );
  }, [query]);

  // Keep the highlighted row in range as results shrink.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, results.length - 1)));
  }, [results.length]);

  function go(cmd: Command | undefined) {
    if (!cmd) return;
    setOpen(false);
    router.push(cmd.href);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">Command palette</DialogTitle>
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, results.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(results[active]);
              }
            }}
            placeholder="Search or jump to…"
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Command palette"
          />
        </div>
        <ul className="max-h-80 overflow-auto p-1.5">
          {results.length === 0 ? (
            <li className="px-3 py-6 text-center text-sm text-muted-foreground">No matches.</li>
          ) : (
            results.map((cmd, i) => {
              const Icon = cmd.icon;
              return (
                <li key={`${cmd.label}-${cmd.href}`}>
                  <button
                    type="button"
                    onMouseEnter={() => setActive(i)}
                    onClick={() => go(cmd)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm",
                      i === active ? "bg-muted text-foreground" : "text-muted-foreground",
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    <span className="flex-1 text-foreground">{cmd.label}</span>
                    {cmd.hint && (
                      <span className="text-xs text-muted-foreground">{cmd.hint}</span>
                    )}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
