import { and, eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { apiKeys } from "@/db/schema";
import { nowIso } from "@/lib/ids";

// DELETE /api/api-keys/[id] — revoke (soft delete). The row stays for audit;
// the key stops authenticating immediately. Org-admin only.
export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const ctx = await requireAccount();
  if (ctx.auth.orgRole !== "org:admin") {
    throw new HttpError(403, "Only organization admins can manage API keys");
  }

  const key = await ctx.db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.id, id), eq(apiKeys.accountId, ctx.account.id)),
  });
  if (!key) throw new HttpError(404, "Not found");
  if (!key.revokedAt) {
    await ctx.db
      .update(apiKeys)
      .set({ revokedAt: nowIso(), updatedAt: nowIso() })
      .where(eq(apiKeys.id, key.id));
  }
  return json({ ok: true });
});
