import Link from "next/link";
import { SidebarNav } from "./sidebar-nav";
import { SidebarUserFooter } from "./sidebar-user-footer";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarProvider,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
} from "@/components/ui/sidebar";
import { Zap } from "lucide-react";
import { TopNav } from "./top-nav";

export async function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <SidebarProvider className="bg-sidebar">
      <Sidebar>
        <SidebarHeader className="pt-5">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton size="lg" render={<Link href="/dashboard" />}>
                <div className="flex aspect-square size-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Zap className="size-4" />
                </div>
                <div className="grid flex-1 text-left text-sm leading-tight">
                  <span className="truncate font-semibold">Day3</span>
                </div>
              </SidebarMenuButton>
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarHeader>

        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>Platform</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarNav />
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>

        <SidebarFooter>
          <SidebarUserFooter />
        </SidebarFooter>
      </Sidebar>

      <div className="flex-1 p-5 pl-0 peer-data-[state=collapsed]:pl-5 transition-[padding] duration-200 ease-linear">
        <SidebarInset className="rounded-2xl bg-background shadow-sm h-full overflow-y-auto">
          <TopNav />
          <div className="px-10 pb-10 w-full">{children}</div>
        </SidebarInset>
      </div>
    </SidebarProvider>
  );
}
