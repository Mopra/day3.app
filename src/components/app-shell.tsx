"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { OrganizationSwitcher, UserButton } from "@clerk/nextjs";
import {
  CreditCard,
  Globe,
  LayoutDashboard,
  Mail,
  Settings,
  ShieldCheck,
  Users,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useApi } from "@/lib/api";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/campaigns", label: "Campaigns", icon: Mail },
  { to: "/audiences", label: "Audiences", icon: Users },
  { to: "/domains", label: "Domains", icon: Globe },
  { to: "/billing", label: "Billing", icon: CreditCard },
  { to: "/settings", label: "Settings", icon: Settings },
];

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

  const linkClass = (active: boolean) =>
    cn(
      "flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
      active && "bg-muted text-foreground",
    );
  const isActive = (to: string) => pathname === to || pathname.startsWith(`${to}/`);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card/30">
        <div className="flex h-14 items-center px-4 text-lg font-bold tracking-tight">Day3</div>
        <nav className="flex flex-1 flex-col gap-1 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <Link key={to} href={to} className={linkClass(isActive(to))}>
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
          {isAdmin && (
            <Link href="/admin" className={linkClass(isActive("/admin"))}>
              <ShieldCheck className="size-4" />
              Admin
            </Link>
          )}
        </nav>
        <div className="flex items-center justify-between gap-2 border-t border-border p-3">
          <OrganizationSwitcher hidePersonal />
          <UserButton />
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-6">{children}</main>
    </div>
  );
}
