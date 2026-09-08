import { apiRoute } from "@/api/v1/route";
import { apiJson } from "@/api/v1/errors";
import { pageResponse, parsePageQuery } from "@/api/v1/pagination";
import { serializeAutomation } from "@/api/v1/serialize";
import { listAutomationsForApi } from "@/services/automations";

// GET /api/v1/automations: cursor-paginated list, newest first. Needs no scope:
// it names flows, not people. Archived flows are hidden unless ?status=archived.
// An unknown ?status= is a 400 from the service, shared with the MCP list tool.
export const GET = apiRoute(async (req, { db, account }) => {
  const { limit, after } = parsePageQuery(req);
  const status = req.nextUrl.searchParams.get("status");
  const rows = await listAutomationsForApi(db, account.id, { status, limit: limit + 1, after });
  return apiJson(pageResponse(rows, limit, (a) => serializeAutomation(a, a.liveVersion)));
});
