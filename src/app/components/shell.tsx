import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router";
import { OrganizationSwitcher, UserButton } from "@clerk/react";
import {
  Globe,
  LayoutDashboard,
  Mail,
  Settings,
  ShieldCheck,
  Users,
  CreditCard,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useApi } from "../lib/api";

const NAV = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { to: "/campaigns", label: "Campaigns", icon: Mail },
  { to: "/audiences", label: "Audiences", icon: Users },
  { to: "/domains", label: "Domains", icon: Globe },
  { to: "/billing", label: "Billing", icon: CreditCard },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function AppShell() {
  const api = useApi();
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    api
      .get<{ isAdmin: boolean }>("/api/account/me")
      .then((me) => setIsAdmin(me.isAdmin))
      .catch(() => setIsAdmin(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-56 shrink-0 flex-col border-r border-border bg-card/30">
        <div className="flex h-14 items-center px-4 text-lg font-bold tracking-tight">Day3</div>
        <nav className="flex flex-1 flex-col gap-1 px-2">
          {NAV.map(({ to, label, icon: Icon }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  isActive && "bg-muted text-foreground",
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
          {isAdmin && (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground",
                  isActive && "bg-muted text-foreground",
                )
              }
            >
              <ShieldCheck className="size-4" />
              Admin
            </NavLink>
          )}
        </nav>
        <div className="flex items-center justify-between gap-2 border-t border-border p-3">
          <OrganizationSwitcher hidePersonal />
          <UserButton />
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-8 py-6">
        <Outlet />
      </main>
    </div>
  );
}
