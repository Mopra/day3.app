import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { requireOrgAdmin } from "../../route";
import { endpointSecret, getEndpoint, rotateEndpointSecret } from "@/services/webhooks";

type Ctx = { params: Promise<{ id: string }> };

// GET — reveal the signing secret. Unlike an API key (hashed, shown once),
// a webhook secret is recoverable by design: it lives in the receiver's config,
// and "I lost it, mint a new one" would mean an avoidable delivery outage every
// time someone re-deploys. It is org-admin-only and never included in a list
// response, so revealing it is always a deliberate, single, authorized act.
export const GET = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const ctx = await requireAccount();
  requireOrgAdmin(ctx);
  const endpoint = await getEndpoint(ctx.db, ctx.account.id, id);
  if (!endpoint) throw new HttpError(404, "Not found");
  return json({ secret: await endpointSecret(endpoint) });
});

// POST — rotate. We sign with exactly one secret, so the old one stops
// verifying the moment this returns; the UI says so, and the docs describe the
// accept-both-then-rotate order that makes it a zero-downtime change.
export const POST = route<Ctx>(async (_req, { params }) => {
  const { id } = await params;
  const ctx = await requireAccount();
  requireOrgAdmin(ctx);
  const secret = await rotateEndpointSecret(ctx.db, ctx.account.id, id);
  if (!secret) throw new HttpError(404, "Not found");
  return json({ secret });
});
