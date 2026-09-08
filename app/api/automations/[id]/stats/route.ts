import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { getAutomationStats } from "@/services/automations";

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  return json(await getAutomationStats(db, account.id, id));
});
