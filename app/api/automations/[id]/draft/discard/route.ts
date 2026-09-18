import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { discardDraftGraph } from "@/services/automations";

// POST /api/automations/{id}/draft/discard: throw the draft away and reset it to
// the live graph. 409 when nothing has been published yet.
export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  return json(await discardDraftGraph(db, account, id));
});
