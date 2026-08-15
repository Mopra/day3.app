import { and, desc, eq } from "drizzle-orm";
import { apiRoute } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { cursorCondition, pageResponse, parsePageQuery } from "@/api/v1/pagination";
import { requireScope } from "@/api/v1/scopes";
import { serializeWebhookDelivery } from "@/api/v1/serialize";
import { webhookDeliveries, WEBHOOK_DELIVERY_STATUSES, type WebhookDeliveryStatus } from "@/db/schema";
import { getEndpoint } from "@/services/webhooks";

type Ctx = { params: Promise<{ webhookId: string }> };

// GET /v1/webhooks/{id}/deliveries?status= — the delivery log for one endpoint,
// newest first. Scoped like the rest of the webhook surface: these rows name
// the recipients each event was about.
//
// The signed payload is deliberately NOT in this response, unlike the app's own
// log view. Over the API it would be a way to read back every event body — and
// therefore every address — through a paginated endpoint, which is the exact
// shape of access the scope exists to make deliberate. Fetch the underlying
// object by id if you need its content.
export const GET = apiRoute<Ctx>(async (req, { db, account, apiKey }, { params }) => {
  requireScope(apiKey, "webhooks:manage");
  const { webhookId } = await params;

  // 404 on someone else's id rather than returning an empty page, so a caller
  // can tell "wrong id" from "no deliveries yet".
  const endpoint = await getEndpoint(db, account.id, webhookId);
  if (!endpoint) throw new ApiError(404, "not_found", "No webhook endpoint with that id.");

  const { limit, after } = parsePageQuery(req);
  const statusParam = req.nextUrl.searchParams.get("status");
  if (statusParam && !(WEBHOOK_DELIVERY_STATUSES as readonly string[]).includes(statusParam)) {
    throw new ApiError(
      400,
      "invalid_request",
      `status must be one of: ${WEBHOOK_DELIVERY_STATUSES.join(", ")}`,
      { param: "status" },
    );
  }

  const filters = [
    eq(webhookDeliveries.accountId, account.id),
    eq(webhookDeliveries.endpointId, webhookId),
  ];
  if (statusParam) filters.push(eq(webhookDeliveries.status, statusParam as WebhookDeliveryStatus));
  if (after) filters.push(cursorCondition(webhookDeliveries.createdAt, webhookDeliveries.id, after));

  const rows = await db
    .select()
    .from(webhookDeliveries)
    .where(and(...filters))
    .orderBy(desc(webhookDeliveries.createdAt), desc(webhookDeliveries.id))
    .limit(limit + 1);

  return apiJson(pageResponse(rows, limit, serializeWebhookDelivery));
});
