import { redirect } from "next/navigation";
import { auth } from "@clerk/nextjs/server";
import { requireAccount } from "@/api/context";
import { computeOnboardingState } from "@/services/onboarding";
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
  // The onboarding strip rides along on the same memoized account: computeOnboardingState
  // is a handful of pipelined reads and it already ran on nearly every page, so
  // resolving it here (rather than per page, or as a mount fetch) is what lets the
  // "what's next" thread follow the user onto /sending and /audiences instead of
  // living only on the dashboard.
  const { db, account } = await requireAccount();
  const onboarding = await computeOnboardingState(db, account);
  return (
    <AppShell plan={account.plan} onboarding={onboarding}>
      {children}
    </AppShell>
  );
}
