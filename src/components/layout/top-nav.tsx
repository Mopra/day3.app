"use client";

import { usePathname } from "next/navigation";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";

const titles: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/tasks": "Tasks",
  "/campaigns": "Campaigns",
  "/campaigns/new": "New Campaign",
  "/settings": "Settings",
};

function getTitle(pathname: string) {
  return titles[pathname] || "Day3";
}

export function TopNav() {
  const pathname = usePathname();
  const title = getTitle(pathname);

  return (
    <header className="flex items-center gap-3 px-6 py-3 mb-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="!self-auto h-4" />
      <h1 className="text-sm font-medium">{title}</h1>
    </header>
  );
}
