import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { templateSummaries } from "@/lib/automation-templates";

// GET /api/automations/templates. Pure data, but session-gated like every other
// app route so the catalogue is not a public surface.
export const GET = route(async () => {
  await requireAccount();
  return json(templateSummaries());
});
