import { auth, clerkClient } from "@clerk/nextjs/server";
import { getDb, type Db } from "../db/client";
import type { Account } from "../db/schema";
import { getAccountByClerkOrgId, syncCurrentOrganization } from "../services/accounts";
import { HttpError } from "./http";

// The auth facts a handler is allowed to trust. `has` carries Clerk's billing /
// permission check (used for the org plan entitlement).
export type AuthState = {
  userId: string;
  orgId: string | null;
  has: (params: { plan: string } | { permission: string }) => boolean;
};

// Cookie-based Clerk session (clerkMiddleware in proxy.ts populates it). Replaces
// the Hono `requireAuth` Bearer-token middleware.
export async function requireAuth(): Promise<AuthState> {
  const { userId, orgId, has } = await auth();
  if (!userId) throw new HttpError(401, "Unauthorized");
  return { userId, orgId: orgId ?? null, has: has as AuthState["has"] };
}

export type AccountContext = { db: Db; account: Account; auth: AuthState };

// INVARIANT: the account is always resolved server-side from the Clerk org —
// never from a client-supplied id. Created lazily on first sight.
export async function requireAccount(): Promise<AccountContext> {
  const authState = await requireAuth();
  if (!authState.orgId) {
    throw new HttpError(403, "No active organization. Create or select one first.");
  }
  const db = getDb();
  let account = await getAccountByClerkOrgId(db, authState.orgId);
  if (!account) {
    const clerk = await clerkClient();
    account = await syncCurrentOrganization(db, clerk, authState);
  }
  return { db, account, auth: authState };
}

export type AdminContext = { db: Db; auth: AuthState; userEmail: string };

// Admin gate: the signed-in user's primary email must be in ADMIN_EMAILS.
export async function requireAdmin(): Promise<AdminContext> {
  const authState = await requireAuth();
  const adminEmails = (process.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.length === 0) throw new HttpError(403, "Admin access is not configured");

  const clerk = await clerkClient();
  const user = await clerk.users.getUser(authState.userId);
  const email = user.emailAddresses
    .find((e) => e.id === user.primaryEmailAddressId)
    ?.emailAddress.toLowerCase();

  if (!email || !adminEmails.includes(email)) throw new HttpError(403, "Forbidden");
  return { db: getDb(), auth: authState, userEmail: email };
}
