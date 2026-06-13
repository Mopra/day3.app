import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson } from "@/api/http";
import { requireAccount } from "@/api/context";
import { accounts } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { computeAccountHealth } from "@/services/health";

export const GET = route(async () => {
  const { db, account } = await requireAccount();
  const health = await computeAccountHealth(db, account.id);
  return json({ account, health });
});

const UpdateAccountSchema = z.object({
  companyAddress: z.string().max(500).optional(),
});

export const PATCH = route(async (req: NextRequest) => {
  const { db, account } = await requireAccount();
  const data = await parseJson(req, UpdateAccountSchema);
  await db
    .update(accounts)
    .set({ companyAddress: data.companyAddress ?? null, updatedAt: nowIso() })
    .where(eq(accounts.id, account.id));
  return json({ ok: true });
});
