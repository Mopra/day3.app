import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import {
  AutomationSettingsSchema,
  archiveAutomation,
  getAutomationDetail,
  updateAutomationSettings,
} from "@/services/automations";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const detail = await getAutomationDetail(db, account.id, id);
  if (!detail) throw new HttpError(404, "Automation not found");
  return json(detail);
});

// PATCH /api/automations/{id}: settings only. The graph goes through /draft.
export const PATCH = route<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const input = await parseJson(req, AutomationSettingsSchema);
  return json(await updateAutomationSettings(db, account, id, input));
});

// DELETE /api/automations/{id}: archive. Live enrollments exit; a never-published
// draft with no history is removed outright.
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  await archiveAutomation(db, account, id);
  return json({ ok: true });
});
