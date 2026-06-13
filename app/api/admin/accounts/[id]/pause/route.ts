import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { accounts } from "@/db/schema";
import { nowIso } from "@/lib/ids";

const PauseAccountSchema = z.object({ reason: z.string().trim().min(1).max(500) });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db } = await requireAdmin();
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
  return json({ ok: true });
});
