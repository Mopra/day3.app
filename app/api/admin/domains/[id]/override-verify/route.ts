import { eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { sendingDomains } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logAdminAction } from "@/lib/admin-audit";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { db, auth, userEmail } = await requireAdmin();
  const { id } = await params;
  const domain = await db.query.sendingDomains.findFirst({ where: eq(sendingDomains.id, id) });
  if (!domain) throw new HttpError(404, "Not found");

  await db
    .update(sendingDomains)
    .set({ adminOverrideVerified: true, updatedAt: nowIso() })
    .where(eq(sendingDomains.id, domain.id));
  await logAdminAction(db, {
    action: "domain.override_verify",
    actorEmail: userEmail,
    actorUserId: auth.userId,
    targetType: "sending_domain",
    targetId: domain.id,
    details: { accountId: domain.accountId, domain: domain.domain },
  });
  return json({ ok: true });
});
