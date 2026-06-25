import { and, eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { forms } from "@/db/schema";
import { isReservedFieldKey } from "@/lib/form-fields";

// GET /api/audiences/[id]/fields — the custom personalization fields available
// for this audience, derived from the fields its signup forms collect. Used by
// the campaign composer to offer {{custom_field}} merge tags. Reserved keys
// (first_name/last_name/email) are excluded — those are built-in tags already.
export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const rows = await db
    .select({ fields: forms.fields })
    .from(forms)
    .where(and(eq(forms.accountId, account.id), eq(forms.audienceId, audience.id)));

  // Union by key; first label seen wins.
  const byKey = new Map<string, string>();
  for (const row of rows) {
    for (const f of row.fields ?? []) {
      if (isReservedFieldKey(f.key) || byKey.has(f.key)) continue;
      byKey.set(f.key, f.label);
    }
  }

  return json({ fields: [...byKey].map(([key, label]) => ({ key, label })) });
});
