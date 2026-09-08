import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { apiJson } from "@/api/v1/errors";
import { withIdempotency } from "@/api/v1/idempotency";
import { requireScope } from "@/api/v1/scopes";
import { serializeEnrollResult } from "@/api/v1/serialize";
import { enrollContactByApi, findAutomationOr404 } from "@/services/automations";

type Params = { params: Promise<{ automationId: string }> };

// Same attribute rules as POST /v1/audiences/{id}/contacts: flat string map,
// null deletes a key, keys auto-register as fields.
export const EnrollInputSchema = z.object({
  email: z.string().trim().max(320),
  attributes: z.record(z.string().max(60), z.string().max(500).nullable()).optional(),
});

// POST /api/v1/automations/{id}/enroll: enroll one contact in a live automation.
//
// This is the endpoint that turns a customer's own lifecycle events ("trial
// started") into a Day3 flow, and it is the one that puts mail in a stranger's
// inbox, so it needs the `automations:enroll` scope. With `attributes` the
// contact is created in the automation's audience (or its attributes merged) as
// `subscribed` first; without them a missing contact is reported as
// `not_subscribed` rather than created, so enrolling can never quietly grow a
// list. Every entry gate still applies and the outcome names the one that
// refused. Idempotent via Idempotency-Key.
export const POST = apiRoute<Params>(async (req, ctx, { params }: Params) => {
  const { automationId } = await params;
  requireScope(ctx.apiKey, "automations:enroll");
  const automation = await findAutomationOr404(ctx.db, ctx.account.id, automationId);
  const body = await readJson(req, EnrollInputSchema);

  return withIdempotency(ctx, req, `POST /v1/automations/${automation.id}/enroll`, body, async () => {
    const result = await enrollContactByApi(ctx.db, ctx.account, automation, body);
    return apiJson(serializeEnrollResult(result));
  });
});
