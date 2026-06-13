import { eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { PLANS, isPlanKey } from "@/services/plans";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db } = await requireAdmin();
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, id) });
  if (!account) throw new HttpError(404, "Not found");

  const plan = isPlanKey(account.plan) ? PLANS[account.plan] : PLANS.none;
  await db
    .update(accounts)
    .set({
      riskStatus: "normal",
      pausedReason: null,
      sendingEnabled: plan.sendingEnabled && account.subscriptionStatus === "active",
      updatedAt: nowIso(),
    })
    .where(eq(accounts.id, account.id));
  return json({ ok: true });
});
