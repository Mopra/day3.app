import { route, json } from "@/api/http";
import { requireAccount } from "@/api/context";
import { serializeDelivery } from "@/api/webhook-serialize";
import { requireOrgAdmin } from "../webhook-endpoints/route";
import { listDeliveries } from "@/services/webhooks";

// GET /api/webhook-deliveries?endpointId=&limit=&offset= — the delivery log.
// Server-paginated and read on the client (a `load(offset)` machine), which is
// the documented exception to server-rendering a page's first read: this list
// is a debugging surface people page through, not the point of the page.
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export const GET = route(async (req) => {
  const ctx = await requireAccount();
  requireOrgAdmin(ctx);

  const url = new URL(req.url);
  const endpointId = url.searchParams.get("endpointId") ?? undefined;
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit")) || DEFAULT_LIMIT));
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);

  // Fetch one extra to answer "is there another page" without a count query.
  const rows = await listDeliveries(ctx.db, ctx.account.id, {
    endpointId,
    limit: limit + 1,
    offset,
  });
  const hasMore = rows.length > limit;
  return json({ deliveries: rows.slice(0, limit).map(serializeDelivery), hasMore });
});
