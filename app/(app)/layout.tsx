import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { requireAccount } from "@/api/context";
import { AppShell } from "@/components/app-shell";

// Server-side gate for the whole dashboard. Replaces the SPA's <Protected> +
// <RequireOrg> wrappers: no session → sign-in, no active org → org picker.
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { userId, orgId } = await auth();
  if (!userId) redirect("/sign-in");
  if (!orgId) redirect("/select-org");

  // The sidebar's plan pill, resolved here rather than fetched by the client.
  // This costs nothing: `requireAccount` is memoized per request (React `cache`),
  // so the page rendering inside this layout shares the same account lookup — and
  // it replaces a `GET /api/account` round trip that used to fire from <AppShell>
  // on every full load.
  const { account } = await requireAccount();
  return <AppShell plan={account.plan}>{children}</AppShell>;
}
