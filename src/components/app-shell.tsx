"use client";

import { useEffect, useRef, useState } from "react";
import type { ComponentType, RefAttributes } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { OrganizationSwitcher, UserButton, useAuth } from "@clerk/nextjs";
import { Menu, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { useApi } from "@/lib/api";
import { formatDuration } from "@/lib/format";
import { planCanSend, planLabel } from "@/lib/plans-catalog";
import { AiBudgetProvider, useAiBudget } from "@/components/ai-budget-context";
import { HelpButton } from "@/components/help-button";
import { NotificationBell } from "@/components/notification-bell";
import { CommandPalette } from "@/components/command-palette";
import { LayoutGridIcon } from "@/components/ui/animated-icons/layout-grid";
import { MailCheckIcon } from "@/components/ui/animated-icons/mail-check";
import { SendIcon } from "@/components/ui/animated-icons/send";
import { ChartColumnIcon } from "@/components/ui/animated-icons/chart-column";
import { ActivityIcon } from "@/components/ui/animated-icons/activity";
import { UsersIcon } from "@/components/ui/animated-icons/users";
import { FormInputIcon } from "@/components/ui/animated-icons/form-input";
import { AtSignIcon } from "@/components/ui/animated-icons/at-sign";
import { EarthIcon } from "@/components/ui/animated-icons/earth";
import { CreditCardIcon } from "@/components/ui/animated-icons/credit-card";
import { KeyRoundIcon } from "@/components/ui/animated-icons/key-round";
import { SettingsIcon } from "@/components/ui/animated-icons/settings";
import { ShieldCheckIcon } from "@/components/ui/animated-icons/shield-check";
import { BanIcon } from "@/components/ui/animated-icons/ban";

type AnimatedIconHandle = {
  startAnimation: () => void;
  stopAnimation: () => void;
};
type AnimatedIcon = ComponentType<
  { size?: number; className?: string } & RefAttributes<AnimatedIconHandle>
>;
type NavEntry = { to: string; label: string; icon: AnimatedIcon };

const NAV: NavEntry[] = [
  // Dashboard, Campaigns + Audiences lead as the daily-driver pages (an audience
  // is the campaign's counterpart, so it sits just below), then the rest follows
  // the real first-run setup flow (see OnboardingChecklist): who you may mail
  // (Suppressions) → what you send as (Domains → Senders) → grow your audience
  // (Forms) → measure (Metrics) → account (Billing, API keys, Settings).
  { to: "/dashboard", label: "Dashboard", icon: LayoutGridIcon },
  { to: "/campaigns", label: "Campaigns", icon: MailCheckIcon },
  { to: "/emails", label: "Emails", icon: SendIcon },
  { to: "/audiences", label: "Audiences", icon: UsersIcon },
  { to: "/suppressions", label: "Suppressions", icon: BanIcon },
  { to: "/domains", label: "Domains", icon: EarthIcon },
  { to: "/senders", label: "Senders", icon: AtSignIcon },
  { to: "/forms", label: "Forms", icon: FormInputIcon },
  { to: "/metrics", label: "Metrics", icon: ChartColumnIcon },
  { to: "/activity", label: "Activity", icon: ActivityIcon },
  { to: "/billing", label: "Billing", icon: CreditCardIcon },
  { to: "/api-keys", label: "API keys", icon: KeyRoundIcon },
  { to: "/settings", label: "Settings", icon: SettingsIcon },
];

function NavItem({
  to,
  label,
  icon: Icon,
  active,
  onNavigate,
}: NavEntry & { active: boolean; onNavigate?: () => void }) {
  const iconRef = useRef<AnimatedIconHandle>(null);
  return (
    <Link
      href={to}
      onClick={onNavigate}
      onMouseEnter={() => iconRef.current?.startAnimation()}
      onMouseLeave={() => iconRef.current?.stopAnimation()}
      className={cn(
        // py-2.5 below md keeps the row at a 44px touch target on a phone; the
        // desktop rhythm (py-2) is restored from md up.
        "flex items-center gap-2 rounded-lg px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:py-2",
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

// Session-scoped caches, module-level so they survive component remounts and
// client-side navigations within the same page-session. Keyed by orgId; a real
// org switch does a full window reload (useReloadOnOrgChange), which resets them.
//   - meCache: /api/account/me runs a Clerk getUser server-side; caching it means
//     that round-trip happens once per session instead of on every navigation.
//   - sessionSynced: gates the once-per-session /api/account/sync fallback (and
//     defuses React StrictMode's double-effect in dev).
let meCache: { orgId: string; promise: Promise<{ isAdmin: boolean }> } | null = null;
const sessionSynced = new Set<string>();

// `plan` is resolved by the server layout and passed in — it rides along on the
// account lookup the page already does, so the pill costs no request of its own.
export function AppShell({ children, plan }: { children: React.ReactNode; plan: string }) {
  const api = useApi();
  const pathname = usePathname();
  const { orgId } = useAuth();
  const [isAdmin, setIsAdmin] = useState(false);
  const [navOpen, setNavOpen] = useState(false);
  useReloadOnOrgChange();

  // Close the drawer when the viewport grows past the breakpoint where the
  // sidebar becomes permanent. Its content is `md:hidden`, so a drawer left
  // open across a rotate or a resize would otherwise leave the backdrop up with
  // nothing visible inside it — a locked page with no way out.
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 48rem)");
    const sync = () => {
      if (mq.matches) setNavOpen(false);
    };
    sync();
    mq.addEventListener("change", sync);
    return () => mq.removeEventListener("change", sync);
  }, []);

  useEffect(() => {
    if (!orgId) return;
    // isAdmin (ADMIN_EMAILS membership) is stable within a session — cache the
    // Clerk getUser behind /api/account/me so it isn't repeated per navigation.
    // Deliberately left on the client, AFTER paint: resolving it in the server
    // layout instead would put a Clerk API round trip in front of every render of
    // every page, to decide whether one nav item appears.
    if (!meCache || meCache.orgId !== orgId) {
      meCache = {
        orgId,
        promise: api
          .get<{ isAdmin: boolean }>("/api/account/me")
          .catch(() => ({ isAdmin: false })),
      };
    }
    void meCache.promise.then((me) => setIsAdmin(!!me.isAdmin));

    // Once per session, off the critical path: refresh entitlements from the
    // session billing claims and pick up a tester publicMetadata override /
    // lazily seed the account where the Clerk webhook isn't delivered. This is
    // the ONLY place the (Clerk-API-heavy) sync still runs — everything else reads
    // the webhook-maintained row.
    if (!sessionSynced.has(orgId)) {
      sessionSynced.add(orgId);
      void api.post("/api/account/sync").catch(() => {});
    }
  }, [api, orgId]);

  const isActive = (to: string) => pathname === to || pathname.startsWith(`${to}/`);

  const adminNav: NavEntry[] = isAdmin
    ? [{ to: "/admin", label: "Admin", icon: ShieldCheckIcon }]
    : [];

  return (
    <AiBudgetProvider>
      {/* h-dvh, not h-screen: on iOS Safari `100vh` is the *largest* viewport
          height (URL bar retracted), so a full-height shell puts its bottom
          edge — and any content pinned to it — behind the browser chrome until
          the user scrolls. dvh tracks the visible height instead. */}
      <div className="relative flex h-dvh flex-col bg-background">
        {/*
          The desk. The sidebar carries no background of its own and the content
          panel floats inside a gutter, so everything outside the panel is one
          continuous surface — this gives that surface paper tooth and a single
          slow warm wash, which is what makes the lit panel read as a sheet
          resting on something rather than a div on a flat fill. It also puts the
          app shell in the same visual language as the campaign composer canvas,
          which is deliberately "a lit sheet on a dark desk" already.

          Decorative, non-interactive, and behind everything (`-z-10` paints
          above the parent's fill but below all in-flow content, and the panel's
          own `bg-card` is opaque). Motion stops under prefers-reduced-motion;
          the grain stays, since it isn't motion. See globals.css.

          This layer carries `bg-background` itself, which is load-bearing and
          not a duplicate of the parent's: `-z-10` makes it a stacking context,
          and a stacking context is an isolated group, so the grain's
          soft-light blend can only mix with pixels painted *inside* this div.
          Without a fill of its own the grain would blend against transparency
          and render as nothing at all. `isolate` is therefore redundant here —
          stated anyway so a later refactor that drops the z-index doesn't
          silently leak the blend onto the whole page.
        */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 -z-10 isolate overflow-hidden bg-background"
        >
          {/*
            Positioned left and low, where the desk is actually visible — a wash
            centred under the content panel would be covered by it.

            Held very low on purpose, and olive leads rather than caramel: the
            surfaces around these are neutral grey, so a warm wash has nothing
            to blend into and any real strength reads as a brown stain on the
            page rather than as depth. Olive is green-grey and disappears into
            neutral far more gracefully than caramel does. If the desk ever
            wants more life, add contrast to the grain before raising these.
          */}
          <div className="absolute -left-32 -top-40 size-[36rem] rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--caramel)_8%,transparent),transparent_70%)] blur-3xl animate-desk-wash-1" />
          <div className="absolute -bottom-48 -left-24 size-[32rem] rounded-full bg-[radial-gradient(circle,color-mix(in_srgb,var(--olive)_11%,transparent),transparent_70%)] blur-3xl animate-desk-wash-2" />
          <div className="d3-desk-grain absolute inset-0" />
        </div>
        {/* Mobile top bar. Below md the sidebar is off-canvas, so the shell needs
            a persistent place to open it from — plus the mark (a way home) and
            the account menu, the two sidebar controls worth keeping one tap
            away. Everything else lives in the drawer. */}
        <header className="flex h-14 shrink-0 items-center gap-1 px-3 md:hidden">
          <button
            type="button"
            onClick={() => setNavOpen(true)}
            aria-label="Open navigation"
            className="-ml-1 flex size-10 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Menu className="size-5" />
          </button>
          <Link href="/dashboard" className="flex h-10 items-center px-1">
            <Image src="/day3-mark-light.svg" alt="Day3" width={46} height={13} priority />
          </Link>
          <div className="ml-auto flex items-center gap-1">
            <UserButton appearance={{ elements: { userButtonTrigger: { padding: 0 } } }} />
          </div>
        </header>

        {/* The off-canvas nav. Same content as the desktop sidebar, so there is
            one nav to maintain; it closes on navigation (see onNavigate) because
            an App Router push doesn't unmount the shell. */}
        <Sheet open={navOpen} onOpenChange={setNavOpen}>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-[17rem] max-w-[85vw] overflow-y-auto p-0 md:hidden"
          >
            <SheetTitle className="sr-only">Navigation</SheetTitle>
            <SidebarBody
              plan={plan}
              nav={[...NAV, ...adminNav]}
              isActive={isActive}
              onNavigate={() => setNavOpen(false)}
            />
          </SheetContent>
        </Sheet>

        <div className="flex min-h-0 flex-1">
          <aside className="hidden w-56 shrink-0 md:flex md:flex-col">
            <SidebarBody plan={plan} nav={[...NAV, ...adminNav]} isActive={isActive} />
          </aside>
          <div className="flex min-w-0 flex-1 flex-col">
            {/* No top chrome bar on desktop: each page renders its own heading,
                and the account controls live in the sidebar. The content panel
                floats — and now casts, so it reads as a lit sheet lying on the
                desk behind it rather than a differently-coloured rectangle. A
                wide, soft, almost entirely downward shadow: a sheet resting on a
                surface, not a card hovering above one.

                The gutter and inner padding shrink on a phone: at 375px the
                desktop m-5 + px-8 spends 26 % of the width on margin, which is
                what makes a table or a form field feel cramped there. */}
            <main className="mx-3 mb-3 min-h-0 flex-1 overflow-auto rounded-2xl border border-border bg-card px-4 py-5 shadow-[0_18px_50px_-24px_oklch(0_0_0/0.85)] sm:mx-4 sm:mb-4 sm:px-6 md:m-5 md:px-8 md:py-6">
              {children}
            </main>
          </div>
        </div>
      </div>
      <CommandPalette />
    </AiBudgetProvider>
  );
}

// The sidebar's contents, shared by the fixed desktop rail and the mobile
// drawer. `onNavigate` is only passed by the drawer — a client-side navigation
// doesn't unmount the shell, so without it the drawer would stay open over the
// page the user just asked for.
function SidebarBody({
  plan,
  nav,
  isActive,
  onNavigate,
}: {
  plan: string;
  nav: NavEntry[];
  isActive: (to: string) => boolean;
  onNavigate?: () => void;
}) {
  return (
    <div className="flex min-h-full flex-col">
      <Link href="/dashboard" onClick={onNavigate} className="flex h-14 items-center px-4">
        <Image src="/day3-mark-light.svg" alt="Day3" width={46} height={13} priority />
      </Link>
      {/* Workspace switcher — top of the sidebar, directly under the mark
          and above the nav: the org scopes everything below it, so it
          reads as the context for the whole list. px-5 (20px) matches the
          nav/Help/AI gutter; the switcher's own left padding is zeroed so
          its avatar sits flush at that gutter rather than a few px right.
          min-w-0 lets a long org name truncate (ellipsis) instead of
          pushing the chevron out of the fixed-width sidebar. */}
      <div className="min-w-0 px-5 pb-3">
        <OrganizationSwitcher
          hidePersonal
          appearance={{
            elements: {
              organizationSwitcherTrigger: {
                paddingLeft: 0,
                maxWidth: "100%",
                minWidth: 0,
              },
              organizationPreview: { minWidth: 0 },
              organizationPreviewTextContainer: { minWidth: 0 },
              organizationPreviewMainIdentifier: {
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              },
            },
          }}
        />
      </div>
      <nav className="flex flex-1 flex-col gap-1 px-2">
        {nav.map((item) => (
          <NavItem
            key={item.to}
            {...item}
            active={isActive(item.to)}
            onNavigate={onNavigate}
          />
        ))}
      </nav>
      {/* Notifications + Help — navigation-style items above the AI meter.
          The bell surfaces async account events (finished sends, failed
          schedules, capped signups); no docs site yet, so Help's popover is
          the whole help surface. */}
      <div className="px-2 pt-1 pb-1">
        <NotificationBell />
        <HelpButton />
      </div>
      {/* Plan pill — a persistent reminder of the tier. Free links to
          billing (its whole value is the upgrade path); paid plans just
          show the tier. */}
      <div className="px-4 pb-1">
        {planCanSend(plan) ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground">
            {planLabel(plan)} plan
          </span>
        ) : (
          <Link
            href="/billing"
            onClick={onNavigate}
            className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
          >
            {planLabel(plan)} plan · Upgrade
          </Link>
        )}
      </div>
      <SidebarAiBudget />
      {/* Account control, bottom-left of the sidebar — the conventional
          placement for the personal profile/sign-out menu. px-5 (20px)
          matches the nav/Help/AI gutter, and the trigger's own padding is
          zeroed so the avatar sits flush at that gutter. */}
      <div className="flex items-center px-5 py-3 mb-5">
        <UserButton appearance={{ elements: { userButtonTrigger: { padding: 0 } } }} />
      </div>
    </div>
  );
}
