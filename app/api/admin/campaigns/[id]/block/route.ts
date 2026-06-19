import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { campaigns } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logAdminAction } from "@/lib/admin-audit";

const BlockSchema = z.object({ reason: z.string().trim().max(500).optional() });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { db, auth, userEmail } = await requireAdmin();
  const { id } = await params;
  const data = await parseJson(req, BlockSchema);
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
  if (!campaign) throw new HttpError(404, "Not found");

  const reason = data.reason ?? "Blocked by admin.";
  await db
    .update(campaigns)
    .set({
      status: "blocked",
      pausedReason: reason,
      updatedAt: nowIso(),
    })
    .where(eq(campaigns.id, campaign.id));
  await logAdminAction(db, {
    action: "campaign.block",
    actorEmail: userEmail,
    actorUserId: auth.userId,
    targetType: "campaign",
    targetId: campaign.id,
    details: { accountId: campaign.accountId, reason },
  });
  return json({ ok: true });
});
