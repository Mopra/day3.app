import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { ApiError, apiJson } from "@/api/v1/errors";
import { requireScope } from "@/api/v1/scopes";
import { serializeWebhookEndpoint } from "@/api/v1/serialize";
import { WEBHOOK_EVENT_TYPES } from "@/db/schema";
import {
  deleteEndpoint,
  getEndpoint,
  updateEndpoint,
  WebhookConfigError,
} from "@/services/webhooks";

type Ctx = { params: Promise<{ webhookId: string }> };

export const GET = apiRoute<Ctx>(async (_req, { db, account, apiKey }, { params }) => {
  requireScope(apiKey, "webhooks:manage");
  const { webhookId } = await params;
  const endpoint = await getEndpoint(db, account.id, webhookId);
  if (!endpoint) throw new ApiError(404, "not_found", "No webhook endpoint with that id.");
  return apiJson(serializeWebhookEndpoint(endpoint));
});

const PatchSchema = z.object({
  url: z.string().trim().min(1).max(2000).optional(),
  description: z.string().trim().max(200).nullish(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1).optional(),
  // Pausing over the API is allowed; it stops delivery without losing the
  // endpoint's id or its secret, which is what a deploy-time toggle wants.
  status: z.enum(["enabled", "disabled"]).optional(),
});

export const PATCH = apiRoute<Ctx>(async (req, { db, account, apiKey }, { params }) => {
  requireScope(apiKey, "webhooks:manage");
  const { webhookId } = await params;
  const patch = await readJson(req, PatchSchema);

  try {
    const endpoint = await updateEndpoint(db, account.id, webhookId, {
      ...patch,
      description: patch.description === undefined ? undefined : (patch.description ?? null),
    });
    if (!endpoint) throw new ApiError(404, "not_found", "No webhook endpoint with that id.");
    return apiJson(serializeWebhookEndpoint(endpoint));
  } catch (err) {
    if (err instanceof WebhookConfigError) {
      throw new ApiError(400, "invalid_request", err.message, { param: err.param });
    }
    throw err;
  }
});

export const DELETE = apiRoute<Ctx>(async (_req, { db, account, apiKey }, { params }) => {
  requireScope(apiKey, "webhooks:manage");
  const { webhookId } = await params;
  const deleted = await deleteEndpoint(db, account.id, webhookId);
  if (!deleted) throw new ApiError(404, "not_found", "No webhook endpoint with that id.");
  return apiJson({ id: webhookId, object: "webhook_endpoint", deleted: true });
});
