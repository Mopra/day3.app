import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { cursorCondition, pageResponse, parsePageQuery } from "@/api/v1/pagination";
import { requireScope } from "@/api/v1/scopes";
import { serializeWebhookEndpoint } from "@/api/v1/serialize";
import { WEBHOOK_EVENT_TYPES, webhookEndpoints } from "@/db/schema";
import { createEndpoint, WebhookConfigError } from "@/services/webhooks";

// Webhook endpoint management over the public API, so endpoints can be
// provisioned from code or infrastructure-as-code rather than clicked in.
//
// Every route here requires `webhooks:manage` — including the reads. An
// endpoint is a standing feed of every address the account mails, so creating
// one is the only write in v1 that is an exfiltration primitive rather than a
// content edit; the list and the delivery log are gated too, because the log
// carries event payloads and those carry recipient addresses.
//
// The signing secret is returned exactly once, by POST, and has no other v1
// representation — reveal and rotate stay in the app UI behind a session.

export const GET = apiRoute(async (req, { db, account, apiKey }) => {
  requireScope(apiKey, "webhooks:manage");
  const { limit, after } = parsePageQuery(req);
  const filters = [eq(webhookEndpoints.accountId, account.id)];
  if (after) filters.push(cursorCondition(webhookEndpoints.createdAt, webhookEndpoints.id, after));

  const rows = await db
    .select()
    .from(webhookEndpoints)
    .where(and(...filters))
    .orderBy(desc(webhookEndpoints.createdAt), desc(webhookEndpoints.id))
    .limit(limit + 1);

  return apiJson(pageResponse(rows, limit, serializeWebhookEndpoint));
});

const CreateSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  description: z.string().trim().max(200).nullish(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
});

export const POST = apiRoute(async (req, { db, account, apiKey }) => {
  requireScope(apiKey, "webhooks:manage");
  const body = await readJson(req, CreateSchema);

  try {
    const { endpoint, secret } = await createEndpoint(db, {
      accountId: account.id,
      url: body.url,
      description: body.description ?? null,
      events: body.events,
      // Attribution: the key, not a user — this endpoint was provisioned by a
      // machine, and the key list is where you go to find out which one.
      createdBy: `api_key:${apiKey.id}`,
    });
    // The only time `secret` appears in an API response. Store it now.
    return apiJson({ ...serializeWebhookEndpoint(endpoint), secret }, 201);
  } catch (err) {
    if (err instanceof WebhookConfigError) {
      throw new ApiError(400, "invalid_request", err.message, { param: err.param });
    }
    throw err;
  }
});
