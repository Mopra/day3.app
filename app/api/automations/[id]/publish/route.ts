import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import type { PublishFailure } from "@/lib/automation-types";
import { publishAutomation } from "@/services/automations";

// POST /api/automations/{id}/publish. 200 with the detail on success; 422 with a
// PublishFailure (the offending nodes in `validation`) when a gate stops it.
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account, auth } = await requireAccount();
  const result = await publishAutomation(db, account, id, auth.userId);
  if (!result.ok) {
    const failure: PublishFailure = { error: result.error, validation: result.validation };
    return json(failure, 422);
  }
  return json(result.detail);
});
