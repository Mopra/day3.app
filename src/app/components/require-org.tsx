import { useAuth } from "@clerk/react";
import { Navigate } from "react-router";

// The tenant boundary is the Clerk organization: without an active org there
// is no account to scope data to.
export function RequireOrg({ children }: { children: React.ReactNode }) {
  const { isLoaded, orgId } = useAuth();
  if (!isLoaded) return null;
  if (!orgId) return <Navigate to="/select-org" replace />;
  return <>{children}</>;
}
