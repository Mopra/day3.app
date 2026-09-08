import { route, json, parseJson } from "@/api/http";
import { requireAccount } from "@/api/context";
import { DraftGraphSchema, saveDraftGraph } from "@/services/automations";

// PUT /api/automations/{id}/draft: replace the draft graph wholesale. Validation
// is recomputed and returned on the detail; a broken draft saves fine, publish is
// the gate.
export const PUT = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const input = await parseJson(req, DraftGraphSchema);
  return json(await saveDraftGraph(db, account, id, input));
});
