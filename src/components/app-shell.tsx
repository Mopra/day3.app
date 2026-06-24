"use client";

import { useEffect, useRef, useState } from "react";
import type { ComponentType, RefAttributes } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { OrganizationSwitcher, UserButton, useAuth } from "@clerk/nextjs";
import { Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useApi } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { AiBudgetProvider, useAiBudget } from "@/components/ai-budget-context";
import { HelpButton } from "@/components/help-button";
import { LayoutGridIcon } from "@/components/ui/animated-icons/layout-grid";
import { MailCheckIcon } from "@/components/ui/animated-icons/mail-check";
import { ChartColumnIcon } from "@/components/ui/animated-icons/chart-column";
import { UsersIcon } from "@/components/ui/animated-icons/users";
import { FormInputIcon } from "@/components/ui/animated-icons/form-input";
import { AtSignIcon } from "@/components/ui/animated-icons/at-sign";
import { EarthIcon } from "@/components/ui/animated-icons/earth";
import { CreditCardIcon } from "@/components/ui/animated-icons/credit-card";
import { SettingsIcon } from "@/components/ui/animated-icons/settings";
import { ShieldCheckIcon } from "@/components/ui/animated-icons/shield-check";

type AnimatedIconHandle = {
  startAnimation: () => void;
  stopAnimation: () => void;
};
type AnimatedIcon = ComponentType<
  { size?: number; className?: string } & RefAttributes<AnimatedIconHandle>
>;
type NavEntry = { to: string; label: string; icon: AnimatedIcon };

const NAV: NavEntry[] = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutGridIcon },
  { to: "/campaigns", label: "Campaigns", icon: MailCheckIcon },
  { to: "/metrics", label: "Metrics", icon: ChartColumnIcon },
  { to: "/audiences", label: "Audiences", icon: UsersIcon },
  { to: "/forms", label: "Forms", icon: FormInputIcon },
  { to: "/senders", label: "Senders", icon: AtSignIcon },
  { to: "/domains", label: "Domains", icon: EarthIcon },
  { to: "/billing", label: "Billing", icon: CreditCardIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

function NavItem({ to, label, icon: Icon, active }: NavEntry & { active: boolean }) {
  const iconRef = useRef<AnimatedIconHandle>(null);
  return (
    <Link
      href={to}
      onMouseEnter={() => iconRef.current?.startAnimation()}
      onMouseLeave={() => iconRef.current?.stopAnimation()}
      className={cn(
        "flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      <Icon ref={iconRef} size={16} className="inline-flex shrink-0" />
      {label}
    </Link>
  );
}

// The org's shared AI assist allowance, shown only here — a deliberately quiet
// meter that fills as the budget is used. When spent, it shows when it resets.
// Renders nothing when AI isn't configured.
function SidebarAiBudget() {
  const { enabled, budget } = useAiBudget();
  if (!enabled || !budget) return null;
  const fill = budget.exhausted ? 100 : budget.percentUsed;
  return (
    // px-5 (20px) so the sparkle lines up with the nav/Help icons (nav px-2 +
    // item px-3 = 20px), not the shallower px-3 it used before. pt-3 gives the
    // meter breathing room below the Help item (only applied when it renders).
    <div className="px-5 pt-3 pb-1">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <Sparkles className="size-3" />
          AI assist
        </span>
        <span className="tabular-nums">{fill}%</span>
      </div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all",
            budget.exhausted ? "bg-muted-foreground/50" : "bg-foreground/30",
          )}
          style={{ width: `${fill}%` }}
        />
      </div>
      {budget.exhausted && (
        <p className="mt-1 text-[11px] leading-tight text-muted-foreground/70">
          {budget.reason === "month"
            ? "Resets next month"
            : `Resets in ${formatDuration(budget.resetsInSeconds)}`}
        </p>
      )}
    </div>
  );
}

// Switching the active org (via OrganizationSwitcher) only updates Clerk's
// client session — it doesn't navigate, so the server layout's org gate and the
// pages' client-side fetches (keyed off the cookie, not React state) keep their
// stale data until a manual refresh. Watch the active orgId and hard-reload on a
// real change so every page re-resolves against the new org, exactly like the
// manual refresh that already works.
function useReloadOnOrgChange() {
  const { isLoaded, orgId } = useAuth();
  const prevOrgId = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (!isLoaded) return;
    const current = orgId ?? null;
    // First loaded render establishes the baseline without reloading.
    if (prevOrgId.current === undefined) {
      prevOrgId.current = current;
      return;
    }
    if (prevOrgId.current !== current) {
      prevOrgId.current = current;
      window.location.reload();
    }
  }, [isLoaded, orgId]);
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const api = useApi();
  const pathname = usePathname();
  const [isAdmin, setIsAdmin] = useState(false);
  useReloadOnOrgChange();

  useEffect(() => {
    api
      .get<{ isAdmin: boolean }>("/api/account/me")
      .then((me) => setIsAdmin(me.isAdmin))
      .catch(() => setIsAdmin(false));
  }, [api]);

  const isActive = (to: string) => pathname === to || pathname.startsWith(`${to}/`);

  const adminNav: NavEntry[] = isAdmin
    ? [{ to: "/admin", label: "Admin", icon: ShieldCheckIcon }]
    : [];

  return (
    <AiBudgetProvider>
      <div className="flex h-screen bg-background">
        <aside className="flex w-56 shrink-0 flex-col">
          <Link href="/dashboard" className="flex h-14 items-center px-4">
            <Image
              src="/day3-mark-light.svg"
              alt="Day3"
              width={46}
              height={13}
              priority
            />
          </Link>
          <nav className="flex flex-1 flex-col gap-1 px-2">
            {[...NAV, ...adminNav].map((item) => (
              <NavItem key={item.to} {...item} active={isActive(item.to)} />
            ))}
          </nav>
          {/* Help — a navigation-style item, kept above the AI budget meter.
              No docs site yet, so the popover is the whole help surface. */}
          <div className="px-2 pb-1">
            <HelpButton />
          </div>
          <SidebarAiBudget />
          {/* Workspace + account controls, bottom-left of the sidebar — the
              conventional placement. px-5 (20px) matches the nav/Help/AI gutter;
              the org switcher's own left padding is zeroed so its avatar sits
              flush at that gutter rather than a few px to the right. */}
          <div className="flex items-center justify-between gap-2 px-5 py-3 mb-5">
            <OrganizationSwitcher
              hidePersonal
              appearance={{ elements: { organizationSwitcherTrigger: { paddingLeft: 0 } } }}
            />
            <UserButton />
          </div>
        </aside>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* No top chrome bar: each page renders its own heading, and the
              account controls live in the sidebar. The content panel floats. */}
          <main className="m-5 min-h-0 flex-1 overflow-auto rounded-2xl border border-border bg-card px-8 py-6">
            {children}
          </main>
        </div>
      </div>
    </AiBudgetProvider>
  );
}
