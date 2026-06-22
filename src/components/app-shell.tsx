"use client";

import { useEffect, useRef, useState } from "react";
import type { ComponentType, RefAttributes } from "react";
import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import { cn } from "@/lib/utils";
import { useApi } from "@/lib/api";
import { LayoutGridIcon } from "@/components/ui/animated-icons/layout-grid";
import { MailCheckIcon } from "@/components/ui/animated-icons/mail-check";
import { UsersIcon } from "@/components/ui/animated-icons/users";
import { FormInputIcon } from "@/components/ui/animated-icons/form-input";
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
  { to: "/audiences", label: "Audiences", icon: UsersIcon },
  { to: "/forms", label: "Forms", icon: FormInputIcon },
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

export function AppShell({ children }: { children: React.ReactNode }) {
  const api = useApi();
  const pathname = usePathname();
  const [isAdmin, setIsAdmin] = useState(false);

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
  const activeItem = [...NAV, ...adminNav].find(({ to }) => isActive(to));
  const title = activeItem?.label ?? "Day3";

  return (
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
        <div className="flex items-center justify-between gap-2 p-3 mb-5">
          <OrganizationSwitcher hidePersonal />
          <UserButton />
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center px-6">
          <h1 className="text-sm font-medium tracking-tight">{title}</h1>
        </header>
        <main className="min-h-0 flex-1 overflow-auto rounded-2xl border border-border bg-card mr-5 mb-5 ml-5 px-8 py-6">
          {children}
        </main>
      </div>
    </div>
  );
}
