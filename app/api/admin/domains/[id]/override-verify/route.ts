import { eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { sendingDomains } from "@/db/schema";
import { nowIso } from "@/lib/ids";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db } = await requireAdmin();
  const domain = await db.query.sendingDomains.findFirst({ where: eq(sendingDomains.id, id) });
  if (!domain) throw new HttpError(404, "Not found");

  await db
    .update(sendingDomains)
    .set({ adminOverrideVerified: true, updatedAt: nowIso() })
    .where(eq(sendingDomains.id, domain.id));
  return json({ ok: true });
});
