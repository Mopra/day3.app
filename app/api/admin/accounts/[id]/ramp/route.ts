import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logAdminAction } from "@/lib/admin-audit";

// POST /api/admin/accounts/{id}/ramp — lift or restore the new-account send ramp.
//
// The ramp (services/send-ramp.ts) caps how fast a workspace younger than two
// weeks may spend its plan allowance. It is deliberately conservative, which
// means it will occasionally hold up a real customer who signed up on Monday and
// has a genuine 20,000-email announcement to make on Tuesday. This is how an
// operator says "I have looked at this account and it is fine".
//
// Reversible on purpose: `lifted: false` puts the account back under the ramp,
// so a lift granted on a customer's word can be taken back the moment their
// sending stops looking like what they described.
const RampSchema = z.object({ lifted: z.boolean() });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { db, auth, userEmail } = await requireAdmin();
  const { id } = await params;
  const data = await parseJson(req, RampSchema);
  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, id) });
  if (!account) throw new HttpError(404, "Not found");

  await db
    .update(accounts)
    .set({ rampLiftedAt: data.lifted ? nowIso() : null, updatedAt: nowIso() })
    .where(eq(accounts.id, account.id));

  await logAdminAction(db, {
    action: data.lifted ? "account.ramp_lift" : "account.ramp_restore",
    actorEmail: userEmail,
    actorUserId: auth.userId,
    targetType: "account",
    targetId: account.id,
    details: { lifted: data.lifted },
  });

  return json({ ok: true });
});
