"use client";

import { useEffect, useState } from "react";
import { UserButton } from "@clerk/nextjs";
import { getCurrentUserProfile } from "@/server/actions/user";
import { SidebarMenu, SidebarMenuItem, SidebarMenuButton } from "@/components/ui/sidebar";
import { Coins } from "lucide-react";

export function SidebarUserFooter() {
  const [name, setName] = useState<string | null>(null);
  const [credits, setCredits] = useState<number | null>(null);

  useEffect(() => {
    getCurrentUserProfile().then((user) => {
      if (user) {
        setName(user.name);
        setCredits(user.credits);
      }
    });
  }, []);

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" className="cursor-default">
          <UserButton />
          <div className="grid flex-1 text-left text-sm leading-tight">
            <span className="truncate font-semibold">{name ?? "\u00A0"}</span>
            <span className="flex items-center gap-1 truncate text-xs text-muted-foreground">
              <Coins className="size-3" />
              {credits !== null ? `${credits} credits` : "\u00A0"}
            </span>
          </div>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
