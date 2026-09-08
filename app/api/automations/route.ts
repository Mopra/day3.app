import { route, json, parseJson } from "@/api/http";
import { requireAccount } from "@/api/context";
import { listAutomations } from "@/api/lists";
import { CreateAutomationSchema, createAutomation } from "@/services/automations";

// GET /api/automations. The server page calls listAutomations directly; this is
// the same function behind the view's post-mutation re-read.
export const GET = route(async () => {
  const { db, account } = await requireAccount();
  return json(await listAutomations(db, account.id));
});

// POST /api/automations. Creates a draft (optionally seeded from a template)
// with its draft version; nothing here can send.
export const POST = route(async (req) => {
  const { db, account } = await requireAccount();
  const input = await parseJson(req, CreateAutomationSchema);
  return json(await createAutomation(db, account, input), 201);
});
