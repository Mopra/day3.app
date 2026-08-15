import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { serializeEndpoint } from "@/api/webhook-serialize";
import { WEBHOOK_EVENT_TYPES } from "@/db/schema";
import { requireOrgAdmin } from "../route";
import {
  deleteEndpoint,
  getEndpoint,
  updateEndpoint,
  WebhookConfigError,
} from "@/services/webhooks";

type Ctx = { params: Promise<{ id: string }> };

export const GET = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const ctx = await requireAccount();
  requireOrgAdmin(ctx);
  const endpoint = await getEndpoint(ctx.db, ctx.account.id, id);
  if (!endpoint) throw new HttpError(404, "Not found");
  return json({ endpoint: serializeEndpoint(endpoint) });
});

const PatchSchema = z.object({
  url: z.string().trim().min(1).max(2000).optional(),
  description: z.string().trim().max(200).nullable().optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).optional(),
  status: z.enum(["enabled", "disabled"]).optional(),
});

export const PATCH = route<Ctx>(async (req, { params }) => {
  const { id } = await params;
  const ctx = await requireAccount();
  requireOrgAdmin(ctx);
  const patch = await parseJson(req, PatchSchema);

  try {
    const endpoint = await updateEndpoint(ctx.db, ctx.account.id, id, patch);
    if (!endpoint) throw new HttpError(404, "Not found");
    return json({ endpoint: serializeEndpoint(endpoint) });
  } catch (err) {
    if (err instanceof WebhookConfigError) throw new HttpError(400, err.message);
    throw err;
  }
});

// Hard delete, unlike an API key's soft revoke. A key is revoked-not-deleted so
// "what did this credential do" stays answerable; an endpoint performed no
// actions, and its pending deliveries go with it.
export const DELETE = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const ctx = await requireAccount();
  requireOrgAdmin(ctx);
  const deleted = await deleteEndpoint(ctx.db, ctx.account.id, id);
  if (!deleted) throw new HttpError(404, "Not found");
  return json({ ok: true });
});
