import type { WebhookDelivery, WebhookEndpoint } from "../db/schema";

// Public shapes for the app's webhook UI. The signing secret is NEVER in a list
// response — it is only returned by the create call and by the explicit reveal
// endpoint, both of which are org-admin-only and both of which are single
// objects a human asked for by id.

export type SerializedEndpoint = ReturnType<typeof serializeEndpoint>;

export function serializeEndpoint(e: WebhookEndpoint) {
  return {
    id: e.id,
    url: e.url,
    description: e.description,
    events: e.enabledEvents ?? [],
    status: e.status,
    consecutiveFailures: e.consecutiveFailures,
    lastSuccessAt: e.lastSuccessAt,
    lastFailureAt: e.lastFailureAt,
    lastError: e.lastError,
    createdAt: e.createdAt,
  };
}

export type SerializedDelivery = ReturnType<typeof serializeDelivery>;

export function serializeDelivery(d: WebhookDelivery) {
  return {
    id: d.id,
    endpointId: d.endpointId,
    eventId: d.eventId,
    eventType: d.eventType,
    status: d.status,
    attempt: d.attempt,
    responseStatus: d.responseStatus,
    responseBody: d.responseBody,
    error: d.error,
    durationMs: d.durationMs,
    nextAttemptAt: d.nextAttemptAt,
    deliveredAt: d.deliveredAt,
    createdAt: d.createdAt,
    // The signed body, so the log can show exactly what was sent. It is the
    // account's own event data — the same rows the Activity page already shows.
    payload: d.payloadJson,
  };
}
