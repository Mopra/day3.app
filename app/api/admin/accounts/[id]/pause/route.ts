import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logAdminAction } from "@/lib/admin-audit";

const PauseAccountSchema = z.object({ reason: z.string().trim().min(1).max(500) });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { db, auth, userEmail } = await requireAdmin();
  const { id } = await params;
  const data = await parseJson(req, PauseAccountSchema);
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, id) });
  if (!account) throw new HttpError(404, "Not found");

  await db
    .update(accounts)
    .set({
      sendingEnabled: false,
      riskStatus: "paused",
      pausedReason: data.reason,
      updatedAt: nowIso(),
    })
    .where(eq(accounts.id, account.id));
  await logAdminAction(db, {
    action: "account.pause",
    actorEmail: userEmail,
    actorUserId: auth.userId,
    targetType: "account",
    targetId: account.id,
    details: { reason: data.reason },
  });
  return json({ ok: true });
});
