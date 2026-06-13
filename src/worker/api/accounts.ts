import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { accounts } from "../db/schema";
import { nowIso } from "../lib/ids";
import { syncCurrentOrganization } from "../services/accounts";
import { computeAccountHealth } from "../services/health";
import { requireAccount } from "./middleware";
import { parseJson } from "./validate";
import type { AppContext } from "./context";

export const accountRoutes = new Hono<AppContext>();

// Resolve/create the local account for the active org and refresh
// entitlements from session billing claims. Called on dashboard load and from
// the billing page ("refreshBillingEntitlement").
accountRoutes.post("/sync", async (c) => {
  const auth = c.get("auth");
  if (!auth.orgId) {
    return c.json({ error: "No active organization" }, 403);
  }
  const account = await syncCurrentOrganization(c.get("db"), c.get("clerk"), auth);
  return c.json({ account });
});

// Who am I: primary email + admin flag (drives the Admin nav in the UI;
// admin routes themselves re-check on every request).
accountRoutes.get("/me", async (c) => {
  const user = await c.get("clerk").users.getUser(c.get("auth").userId);
  const email =
    user.emailAddresses
      .find((e) => e.id === user.primaryEmailAddressId)
      ?.emailAddress.toLowerCase() ?? "";
  const adminEmails = (c.env.ADMIN_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return c.json({ email, isAdmin: adminEmails.includes(email) });
});

accountRoutes.get("/", requireAccount, async (c) => {
  const account = c.get("account");
  const health = await computeAccountHealth(c.get("db"), account.id);
  return c.json({ account, health });
});

const UpdateAccountSchema = z.object({
  companyAddress: z.string().max(500).optional(),
});

accountRoutes.patch("/", requireAccount, async (c) => {
  const parsed = await parseJson(c, UpdateAccountSchema);
  if (!parsed.ok) return parsed.response;
  const account = c.get("account");
  await c
    .get("db")
    .update(accounts)
    .set({ companyAddress: parsed.data.companyAddress ?? null, updatedAt: nowIso() })
    .where(eq(accounts.id, account.id));
  return c.json({ ok: true });
});
