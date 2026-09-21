import { and, eq, isNull } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { apiKeys } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logAdminAction } from "@/lib/admin-audit";

// DELETE /api/admin/accounts/{id}/api-keys/{keyId} — revoke a tenant's API key.
//
// Pausing an account already refuses its sends at the front door, so this is
// not what stops mail. It is what stops the CALLS: during the September 2026
// incident the attacker's key kept hitting POST /v1/emails for minutes after
// the pause, and an operator had no way to turn it off without a database
// session. A revoked key fails authentication outright, which ends the traffic
// and makes the account's remaining state easier to reason about.
//
// Idempotent: revoking an already-revoked key is a no-op that still returns ok,
// so a double-click during an incident cannot error.
export const DELETE = route<{ params: Promise<{ id: string; keyId: string }> }>(
  async (_req, { params }) => {
    const { db, auth, userEmail } = await requireAdmin();
    const { id, keyId } = await params;

    const key = await db.query.apiKeys.findFirst({
      where: and(eq(apiKeys.id, keyId), eq(apiKeys.accountId, id)),
    });
    if (!key) throw new HttpError(404, "Not found");

    await db
      .update(apiKeys)
      .set({ revokedAt: nowIso(), updatedAt: nowIso() })
      .where(and(eq(apiKeys.id, keyId), isNull(apiKeys.revokedAt)));

    await logAdminAction(db, {
      action: "api_key.revoke",
      actorEmail: userEmail,
      actorUserId: auth.userId,
      targetType: "api_key",
      targetId: keyId,
      details: { accountId: id, keyPrefix: key.keyPrefix },
    });

    return json({ ok: true });
  },
);
