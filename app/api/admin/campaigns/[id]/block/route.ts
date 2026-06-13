import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { campaigns } from "@/db/schema";
import { nowIso } from "@/lib/ids";

const BlockSchema = z.object({ reason: z.string().trim().max(500).optional() });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db } = await requireAdmin();
  const data = await parseJson(req, BlockSchema);
  const campaign = await db.query.campaigns.findFirst({ where: eq(campaigns.id, id) });
  if (!campaign) throw new HttpError(404, "Not found");

  await db
    .update(campaigns)
    .set({
      status: "blocked",
      pausedReason: data.reason ?? "Blocked by admin.",
      updatedAt: nowIso(),
    })
    .where(eq(campaigns.id, campaign.id));
  return json({ ok: true });
});
