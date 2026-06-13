import { OrganizationList, useAuth } from "@clerk/react";
import { Navigate } from "react-router";

export function SelectOrgPage() {
  const { isLoaded, isSignedIn, orgId } = useAuth();
  if (!isLoaded) return null;
  if (!isSignedIn) return <Navigate to="/sign-in" replace />;
  if (orgId) return <Navigate to="/dashboard" replace />;

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
