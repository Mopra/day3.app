import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { subscribers } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { addSuppression } from "@/services/suppression";

const SuppressSchema = z.object({ email: z.email().toLowerCase(), accountId: z.string().min(1) });

// Manual suppression for bounce/complaint handling when provider events aren't
// available.
export const POST = route(async (req) => {
  const { db } = await requireAdmin();
  const data = await parseJson(req, SuppressSchema);
  await addSuppression(db, {
    accountId: data.accountId,
    email: data.email,
    reason: "manual",
    source: "admin",
  });
  await db
    .update(subscribers)
    .set({ status: "suppressed", updatedAt: nowIso() })
    .where(and(eq(subscribers.accountId, data.accountId), eq(subscribers.email, data.email)));
  return json({ ok: true });
});
