"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { OrganizationList, useAuth } from "@clerk/nextjs";

// The tenant boundary is the Clerk organization: without an active org there is
// no account to scope data to.
export default function SelectOrgPage() {
  const { isLoaded, orgId } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (isLoaded && orgId) router.replace("/dashboard");
  }, [isLoaded, orgId, router]);

  if (!isLoaded || orgId) return null;

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6">
      <div className="space-y-1 text-center">
        <h1 className="text-2xl font-semibold">Choose your organization</h1>
        <p className="text-sm text-muted-foreground">
          Each organization is a separate Day3 account with its own plan and audiences.
        </p>
      </div>
      <OrganizationList
        hidePersonal
        afterSelectOrganizationUrl="/dashboard"
        afterCreateOrganizationUrl="/dashboard"
      />
    </div>
  );
}
