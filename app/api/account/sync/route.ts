import { auth, clerkClient } from "@clerk/nextjs/server";
import { route, json, HttpError } from "@/api/http";
import { getDb } from "@/db/client";
import { syncCurrentOrganization } from "@/services/accounts";

// Resolve/create the local account for the active org and refresh entitlements
// from the session billing claims. Called on dashboard load and the billing page.
export const POST = route(async () => {
  const { userId, orgId, orgRole, has } = await auth();
  if (!userId) throw new HttpError(401, "Unauthorized");
  if (!orgId) throw new HttpError(403, "No active organization");
  const clerk = await clerkClient();
  const account = await syncCurrentOrganization(getDb(), clerk, {
    userId,
    orgId,
    orgRole,
    has: has as (params: { plan: string }) => boolean,
  });
  return json({ account });
});
