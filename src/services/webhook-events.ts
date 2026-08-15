import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  webhookDeliveries,
  webhookEndpoints,
  type SuppressionReason,
  type WebhookEventType,
} from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { logger } from "../lib/logger";
import { enqueueBestEffort } from "../queue/enqueue";

// Emission side of outbound webhooks: turn a thing that just happened into
// per-endpoint delivery rows and (best-effort) queue jobs.
//
// THE RULE FOR CALL SITES: emit only where the underlying state actually
// changed. Every event below is emitted from inside a guard that already
// establishes that — an `email_events` insert whose ON CONFLICT DO NOTHING
// actually inserted, or a status UPDATE whose WHERE clause actually matched. SNS
// is at-least-once and queue jobs retry, so an emission placed *next to* those
// guards instead of *inside* them would emit a duplicate event every redelivery.
// The unique index on (endpoint_id, event_id) is the backstop, not the plan.

// --- Payload shapes ---------------------------------------------------------
//
// snake_case, matching the public v1 API — a receiver is usually already parsing
// our REST responses and shouldn't have to hold two conventions in their head.
// Every payload is a flat envelope: { id, type, created_at, data }.

// Deliberately only what the emitting call site already holds. The SES route
// fires one of these per delivery/bounce/complaint notification — i.e. once per
// email we send — so an extra row read to decorate the payload would be an
// extra query on the highest-volume path in the system. A receiver that wants
// the campaign's name or subject fetches it once from GET /v1/campaigns/{id}
// and caches it; the ids here are the join keys.
type EmailEventSource =
  | {
      kind: "campaign";
      campaignId: string;
      recipientId: string;
      subscriberId: string | null;
      email: string;
    }
  | {
      kind: "transactional";
      emailId: string;
      to: string[];
      // The addresses THIS event is about, which for a 50-recipient
      // transactional message is a subset of `to` — SES reports per address.
      email: string;
    };

export type WebhookEventInput =
  | {
      type: Extract<WebhookEventType, "email.sent" | "email.delivered" | "email.complained">;
      accountId: string;
      eventId: string;
      source: EmailEventSource;
      subject: string | null;
      providerMessageId: string | null;
    }
  | {
      type: Extract<WebhookEventType, "email.bounced">;
      accountId: string;
      eventId: string;
      source: EmailEventSource;
      subject: string | null;
      providerMessageId: string | null;
      // "Permanent" | "Transient" | "Undetermined" as SES reports it. Permanent
      // and Undetermined suppress; Transient is informational.
      bounceType: string | null;
      bounceSubType: string | null;
    }
  | {
      type: Extract<WebhookEventType, "email.failed">;
      accountId: string;
      eventId: string;
      source: EmailEventSource;
      subject: string | null;
      providerMessageId: string | null;
      error: string | null;
    }
  | {
      type: Extract<WebhookEventType, "suppression.created">;
      accountId: string;
      eventId: string;
      email: string;
      reason: SuppressionReason;
      source: string | null;
    };

function sourceData(source: EmailEventSource): Record<string, unknown> {
  return source.kind === "campaign"
    ? {
        object: "campaign_recipient",
        campaign_id: source.campaignId,
        recipient_id: source.recipientId,
        contact_id: source.subscriberId,
        email: source.email,
      }
    : {
        object: "email",
        email_id: source.emailId,
        to: source.to,
        email: source.email,
      };
}

/** The exact JSON body we sign and POST. */
export function buildPayload(event: WebhookEventInput, createdAt: string): string {
  const data: Record<string, unknown> =
    event.type === "suppression.created"
      ? { object: "suppression", email: event.email, reason: event.reason, source: event.source }
      : {
          ...sourceData(event.source),
          subject: event.subject,
          provider_message_id: event.providerMessageId,
          ...(event.type === "email.bounced"
            ? { bounce_type: event.bounceType, bounce_subtype: event.bounceSubType }
            : {}),
          ...(event.type === "email.failed" ? { error: event.error } : {}),
        };

  return JSON.stringify({
    id: event.eventId,
    type: event.type,
    created_at: createdAt,
    data,
  });
}

// --- Fan-out ----------------------------------------------------------------

/**
 * Fan an event out to every enabled endpoint subscribed to its type.
 *
 * NEVER THROWS. Callers are on paths whose real work has already committed (the
 * bounce is recorded, the address is suppressed, the mail is sent) and a webhook
 * problem must not undo any of it — least of all on the SES route, where a 500
 * makes SNS redeliver a notification we have already fully processed.
 *
 * Returns the number of deliveries created, for tests and logging.
 */
export async function emitWebhookEvent(db: Db, event: WebhookEventInput): Promise<number> {
  try {
    // Cheap guard on the overwhelmingly common case: an account with no
    // endpoints costs one indexed lookup per event and nothing else.
    const endpoints = await db
      .select({
        id: webhookEndpoints.id,
        enabledEvents: webhookEndpoints.enabledEvents,
        status: webhookEndpoints.status,
      })
      .from(webhookEndpoints)
      .where(eq(webhookEndpoints.accountId, event.accountId));

    const targets = endpoints.filter(
      (e) => e.status === "enabled" && (e.enabledEvents ?? []).includes(event.type),
    );
    if (targets.length === 0) return 0;

    const now = nowIso();
    const payload = buildPayload(event, now);

    // One row per endpoint, inserted before anything is enqueued: Postgres is
    // the source of truth and the queue is only a latency optimization, so a
    // Redis outage degrades delivery from "seconds" to "next cron sweep" rather
    // than losing the event.
    const rows = await db
      .insert(webhookDeliveries)
      .values(
        targets.map((endpoint) => ({
          id: newId("whd"),
          accountId: event.accountId,
          endpointId: endpoint.id,
          eventId: event.eventId,
          eventType: event.type,
          payloadJson: payload,
          status: "pending" as const,
          attempt: 0,
          nextAttemptAt: now,
          createdAt: now,
          updatedAt: now,
        })),
      )
      // A genuine duplicate emission for the same (endpoint, event) is a no-op.
      .onConflictDoNothing()
      .returning({ id: webhookDeliveries.id });

    for (const row of rows) {
      await enqueueBestEffort({
        type: "deliver_webhook",
        deliveryId: row.id,
        accountId: event.accountId,
      });
    }

    return rows.length;
  } catch (err) {
    void logger.reportError("webhook emission failed", err, {
      accountId: event.accountId,
      eventType: event.type,
    });
    return 0;
  }
}
