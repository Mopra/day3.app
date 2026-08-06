"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { OrganizationList, useAuth, useOrganizationList } from "@clerk/nextjs";
import { OrbitLoader } from "@/components/ui/orbit-loader";

// The tenant boundary is the Clerk organization: without an active org there is
// no account to scope data to. This screen wears two hats:
//   • First-run (the user just signed up and has no orgs) — it's really "name
//     your workspace", not "choose" from an empty list. Say so plainly.
//   • Returning (the user belongs to orgs but none is active) — a genuine chooser.
export default function SelectOrgPage() {
  const { isLoaded, orgId } = useAuth();
  const { isLoaded: listLoaded, userMemberships } = useOrganizationList({
    userMemberships: true,
  });
  const router = useRouter();

  useEffect(() => {
    if (isLoaded && orgId) router.replace("/dashboard");
  }, [isLoaded, orgId, router]);

  // Loading — show a spinner rather than a blank white screen while Clerk resolves.
  if (!isLoaded || orgId || !listLoaded) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <OrbitLoader />
      </div>
    );
  }

  const hasOrgs = (userMemberships.count ?? 0) > 0;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 px-4">
      <div className="max-w-sm space-y-1.5 text-center">
        {hasOrgs ? (
          <>
            <h1 className="font-display text-3xl">Choose your workspace</h1>
            <p className="text-sm text-muted-foreground">
              Pick a workspace to continue, or create a new one.
            </p>
          </>
        ) : (
          <>
            <h1 className="font-display text-3xl">One last step</h1>
            <p className="text-sm text-muted-foreground">
              Name your workspace — it&apos;s your company&apos;s Day3 account, where your
              domains, audiences and campaigns live. You can rename it later.
            </p>
          </>
        )}
      </div>
      <OrganizationList
        hidePersonal
        afterSelectOrganizationUrl="/dashboard"
        afterCreateOrganizationUrl="/dashboard"
      />
    </div>
  );
}
