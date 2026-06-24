import { eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logAdminAction } from "@/lib/admin-audit";
import { PLANS, FREE_PLAN, isPlanKey } from "@/services/plans";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { db, auth, userEmail } = await requireAdmin();
  const { id } = await params;
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, id) });
  if (!account) throw new HttpError(404, "Not found");

  const plan = isPlanKey(account.plan) ? PLANS[account.plan] : PLANS[FREE_PLAN];
  await db
    .update(accounts)
    .set({
      riskStatus: "normal",
      pausedReason: null,
      sendingEnabled: plan.sendingEnabled && account.subscriptionStatus === "active",
      updatedAt: nowIso(),
    })
    .where(eq(accounts.id, account.id));
  await logAdminAction(db, {
    action: "account.resume",
    actorEmail: userEmail,
    actorUserId: auth.userId,
    targetType: "account",
    targetId: account.id,
  });
  return json({ ok: true });
});
