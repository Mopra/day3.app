import { route, json, parseJson } from "@/api/http";
import { requireAccount } from "@/api/context";
import { listForms } from "@/api/lists";
import { createSignupForm, CreateFormSchema } from "@/services/form-setup";

// GET /api/forms: list this account's signup forms with their audience name.
export const GET = route(async () => {
  const { db, account } = await requireAccount();
  return json({ forms: await listForms(db, account.id) });
});

// POST /api/forms: create a signup form (services/form-setup.ts, shared with
// the MCP setup tools).
export const POST = route(async (req) => {
  const { db, account } = await requireAccount();
  const input = await parseJson(req, CreateFormSchema);
  return json({ form: await createSignupForm(db, account, input) }, 201);
});
