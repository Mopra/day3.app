import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { resumeAutomation } from "@/services/automations";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  return json(await resumeAutomation(db, account, id));
});
