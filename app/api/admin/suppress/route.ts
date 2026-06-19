import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts, subscribers } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logAdminAction } from "@/lib/admin-audit";
import { addSuppression } from "@/services/suppression";

const SuppressSchema = z.object({ email: z.email().toLowerCase(), accountId: z.string().min(1) });

// Manual suppression for bounce/complaint handling when provider events aren't
// available.
export const POST = route(async (req) => {
  const { db, auth, userEmail } = await requireAdmin();
  const data = await parseJson(req, SuppressSchema);
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, data.accountId) });
  if (!account) throw new HttpError(404, "Not found");

  await addSuppression(db, {
    accountId: account.id,
    email: data.email,
    reason: "manual",
    source: "admin",
  });
  await db
    .update(subscribers)
    .set({ status: "suppressed", updatedAt: nowIso() })
    .where(and(eq(subscribers.accountId, account.id), eq(subscribers.email, data.email)));
  await logAdminAction(db, {
    action: "suppression.add",
    actorEmail: userEmail,
    actorUserId: auth.userId,
    targetType: "account",
    targetId: account.id,
    details: { email: data.email },
  });
  return json({ ok: true });
});
