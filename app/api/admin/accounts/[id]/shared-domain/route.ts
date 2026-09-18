import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAdmin } from "@/api/context";
import { sendingDomains } from "@/db/schema";
import { nowIso } from "@/lib/ids";

// POST /api/admin/accounts/[id]/shared-domain: cut one account off the Day3
// shared test address, or restore it.
//
// The shared SES identity is the one piece of reputation no single tenant owns:
// every account draws on it, so one account abusing it (or simply generating
// complaints from its own team) is everyone else's problem. Sandbox mode bounds
// the damage (org members only, 100 a month), but an operator still needs a
// lever that is narrower than pausing the whole account.
//
// Disabling does not delete the row. The gate in services/shared-domain.ts keeps
// refusing non-sandbox sends on it either way; what this changes is whether the
// account may send from it at all, so a disabled row still fails closed rather
// than becoming an unknown domain.
const BodySchema = z.object({ disabled: z.boolean() });

export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { db } = await requireAdmin();
  const { id } = await params;
  const { disabled } = await parseJson(req, BodySchema);

  const row = await db.query.sendingDomains.findFirst({
    where: and(eq(sendingDomains.accountId, id), eq(sendingDomains.shared, true)),
  });
  if (!row) throw new HttpError(404, "This account has no shared sending domain.");

  await db
    .update(sendingDomains)
    .set({ sharedDisabledAt: disabled ? nowIso() : null, updatedAt: nowIso() })
    .where(eq(sendingDomains.id, row.id));

  return json({ ok: true, disabled });
});
