import { createMiddleware } from "hono/factory";
import { createClerkClient } from "@clerk/backend";
import { createDb } from "../db/client";
import { getAccountByClerkOrgId, syncCurrentOrganization } from "../services/accounts";
import type { AppContext } from "./context";

function authorizedParties(env: Env): string[] {
  const parties = ["http://localhost:5173", "http://127.0.0.1:5173"];
  try {
    parties.push(new URL(env.APP_URL).origin);
  } catch {
    // APP_URL unset/invalid in some dev contexts; localhost entries remain.
  }
  return parties;
}

// Verifies the Clerk session (Bearer token) and provides db/clerk/auth.
export const requireAuth = createMiddleware<AppContext>(async (c, next) => {
  const clerk = createClerkClient({
    secretKey: c.env.CLERK_SECRET_KEY,
    publishableKey: c.env.CLERK_PUBLISHABLE_KEY,
  });

  const state = await clerk.authenticateRequest(c.req.raw, {
    authorizedParties: authorizedParties(c.env),
  });
  if (!state.isAuthenticated) {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const auth = state.toAuth();
  if (!auth.userId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  c.set("db", createDb(c.env.DB));
  c.set("clerk", clerk);
  c.set("auth", {
    userId: auth.userId,
    orgId: auth.orgId ?? null,
    has: auth.has as AppContext["Variables"]["auth"]["has"],
  });
  await next();
});

// Resolves the local account for the active Clerk organization. Account IDs
// always come from this resolution — never from the client.
export const requireAccount = createMiddleware<AppContext>(async (c, next) => {
  const auth = c.get("auth");
  if (!auth.orgId) {
    return c.json({ error: "No active organization. Create or select one first." }, 403);
  }
  let account = await getAccountByClerkOrgId(c.get("db"), auth.orgId);
  if (!account) {
    account = await syncCurrentOrganization(c.get("db"), c.get("clerk"), auth);
  }
  c.set("account", account);
  await next();
});

// Admin gate: the signed-in user's primary email must be in ADMIN_EMAILS.
export const requireAdmin = createMiddleware<AppContext>(async (c, next) => {
  const adminEmails = (c.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (adminEmails.length === 0) {
    return c.json({ error: "Admin access is not configured" }, 403);
  }

  const user = await c.get("clerk").users.getUser(c.get("auth").userId);
  const email = user.emailAddresses
    .find((e) => e.id === user.primaryEmailAddressId)
    ?.emailAddress.toLowerCase();

  if (!email || !adminEmails.includes(email)) {
    return c.json({ error: "Forbidden" }, 403);
  }
  c.set("userEmail", email);
  await next();
});
