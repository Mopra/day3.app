import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { AppShell } from "@/components/app-shell";

// Server-side gate for the whole dashboard. Replaces the SPA's <Protected> +
// <RequireOrg> wrappers: no session → sign-in, no active org → org picker.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");
  if (!orgId) redirect("/select-org");
  return <AppShell>{children}</AppShell>;
}
