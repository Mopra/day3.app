import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount, type AccountContext } from "@/api/context";
import { serializeEndpoint } from "@/api/webhook-serialize";
import { WEBHOOK_EVENT_TYPES } from "@/db/schema";
import { createEndpoint, listEndpoints, WebhookConfigError } from "@/services/webhooks";

// Outbound webhook endpoint management. Session-authenticated and org-admin
// only, for the same reason API keys are: an endpoint is a standing grant of
// this account's event stream to a URL, and the signing secret is readable by
// anyone who can see the endpoint.
//
// Note the route path: `app/api/webhooks/*` is INBOUND (SES/SNS, Clerk). This is
// the outbound side's configuration, so it lives under a name that can't be
// confused with a provider callback.
//
// There is deliberately no public-API equivalent yet. A leaked API key that
// could add a webhook endpoint would be a silent, persistent exfiltration
// channel for every address the account ever mails — worse than anything else a
// key can do. When this does get a v1 surface it will need its own scope.

export function requireOrgAdmin(ctx: AccountContext): void {
  if (ctx.auth.orgRole !== "org:admin") {
    throw new HttpError(403, "Only organization admins can manage webhooks");
  }
}

export const GET = route(async () => {
  const ctx = await requireAccount();
  requireOrgAdmin(ctx);
  const endpoints = await listEndpoints(ctx.db, ctx.account.id);
  return json({ endpoints: endpoints.map(serializeEndpoint) });
});

const CreateSchema = z.object({
  url: z.string().trim().min(1).max(2000),
  description: z.string().trim().max(200).optional(),
  events: z.array(z.enum(WEBHOOK_EVENT_TYPES)).min(1),
});

// POST /api/webhook-endpoints — the signing secret is in this response and in
// the reveal endpoint; it is not in any list.
export const POST = route(async (req) => {
  const ctx = await requireAccount();
  requireOrgAdmin(ctx);
  const body = await parseJson(req, CreateSchema);

  try {
    const { endpoint, secret } = await createEndpoint(ctx.db, {
      accountId: ctx.account.id,
      url: body.url,
      description: body.description,
      events: body.events,
      createdBy: ctx.auth.userId,
    });
    return json({ endpoint: serializeEndpoint(endpoint), secret }, 201);
  } catch (err) {
    if (err instanceof WebhookConfigError) throw new HttpError(400, err.message);
    throw err;
  }
});
