import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  WEBHOOK_EVENT_TYPES,
  webhookDeliveries,
  webhookEndpoints,
  type WebhookDelivery,
  type WebhookEndpoint,
  type WebhookEventType,
} from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { newId, nowIso } from "../lib/ids";
import { generateWebhookSecret } from "../lib/webhook-signature";
import { URL_REJECTION_MESSAGES, validateWebhookUrl } from "../lib/webhook-url";

// Shared vocabulary of the outbound-webhook system. Constants, endpoint CRUD,
// and the retry policy — the emission side lives in webhook-events.ts, the
// actual HTTP call in queue/handlers/deliver-webhook.ts.

export { WEBHOOK_EVENT_TYPES };

// How long we give a receiver to answer before treating the attempt as failed.
// Generous enough for a cold serverless function, short enough that a hung
// endpoint doesn't occupy a worker slot for minutes. A timeout is retried:
// receivers are expected to be idempotent on the event id, which the docs say
// plainly, so a slow-but-successful handler being retried is safe by contract.
export const WEBHOOK_TIMEOUT_MS = 10_000;

// Retry schedule, in delay-before-the-next-attempt order. Six attempts spanning
// ~7 hours: long enough to ride out a deploy, a certificate renewal, or a short
// outage on the receiver's side, bounded so a permanently dead endpoint can't
// accumulate unbounded work. After the last one the delivery is `failed` and
// stays in the log for a manual resend.
export const WEBHOOK_RETRY_DELAYS_MS = [
  30_000, // 30s
  120_000, // 2m
  600_000, // 10m
  1_800_000, // 30m
  3_600_000, // 1h
  21_600_000, // 6h
];
export const WEBHOOK_MAX_ATTEMPTS = WEBHOOK_RETRY_DELAYS_MS.length + 1;

// Receivers' response bodies are stored so a 4xx is debuggable in the UI, but
// they are arbitrary bytes from an arbitrary server — cap them hard.
export const WEBHOOK_RESPONSE_SNIPPET_BYTES = 2_000;

// A delivery claimed but never finished (worker crashed mid-POST) is returned to
// `pending` by the cron sweep after this. Comfortably longer than the request
// timeout so a slow-but-live attempt is never yanked out from under itself.
export const WEBHOOK_STUCK_LOCK_MS = 5 * 60_000;

// Endpoints per account. Not a plan gate — webhooks are how an app stays
// consistent with us, and metering them would be a second meter on something
// that sends no mail (see AGENTS.md rule 5). This is an abuse ceiling only: each
// endpoint multiplies every event into another stored row and another outbound
// request.
export const MAX_ENDPOINTS_PER_ACCOUNT = 10;

export function isWebhookEventType(value: string): value is WebhookEventType {
  return (WEBHOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** Drop unknown entries and de-dupe. An empty result is legal (endpoint subscribed to nothing). */
export function parseEventTypes(raw: unknown): WebhookEventType[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((v): v is WebhookEventType => typeof v === "string" && isWebhookEventType(v)))];
}

export class WebhookConfigError extends Error {
  constructor(
    message: string,
    readonly param?: string,
  ) {
    super(message);
    this.name = "WebhookConfigError";
  }
}

// --- Endpoint CRUD ----------------------------------------------------------

export async function listEndpoints(db: Db, accountId: string): Promise<WebhookEndpoint[]> {
  return db
    .select()
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.accountId, accountId))
    .orderBy(desc(webhookEndpoints.createdAt));
}

export async function getEndpoint(
  db: Db,
  accountId: string,
  id: string,
): Promise<WebhookEndpoint | undefined> {
  const [row] = await db
    .select()
    .from(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.accountId, accountId)))
    .limit(1);
  return row;
}

export async function createEndpoint(
  db: Db,
  input: {
    accountId: string;
    url: string;
    description?: string | null;
    events: WebhookEventType[];
    createdBy: string;
  },
): Promise<{ endpoint: WebhookEndpoint; secret: string }> {
  const validated = validateWebhookUrl(input.url);
  if (!validated.ok) throw new WebhookConfigError(URL_REJECTION_MESSAGES[validated.reason], "url");

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(webhookEndpoints)
    .where(eq(webhookEndpoints.accountId, input.accountId));
  if (count >= MAX_ENDPOINTS_PER_ACCOUNT) {
    throw new WebhookConfigError(
      `You can have at most ${MAX_ENDPOINTS_PER_ACCOUNT} webhook endpoints. Delete one first.`,
    );
  }

  const secret = generateWebhookSecret();
  const now = nowIso();
  const [endpoint] = await db
    .insert(webhookEndpoints)
    .values({
      id: newId("whe"),
      accountId: input.accountId,
      url: validated.url,
      description: input.description?.trim() || null,
      enabledEvents: input.events,
      secretEnc: await encryptSecret(secret),
      status: "enabled",
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning();

  return { endpoint, secret };
}

export async function updateEndpoint(
  db: Db,
  accountId: string,
  id: string,
  patch: {
    url?: string;
    description?: string | null;
    events?: WebhookEventType[];
    status?: "enabled" | "disabled";
  },
): Promise<WebhookEndpoint | undefined> {
  const values: Partial<typeof webhookEndpoints.$inferInsert> = { updatedAt: nowIso() };

  if (patch.url !== undefined) {
    const validated = validateWebhookUrl(patch.url);
    if (!validated.ok) throw new WebhookConfigError(URL_REJECTION_MESSAGES[validated.reason], "url");
    values.url = validated.url;
  }
  if (patch.description !== undefined) values.description = patch.description?.trim() || null;
  if (patch.events !== undefined) values.enabledEvents = patch.events;
  if (patch.status !== undefined) {
    values.status = patch.status;
    // Re-enabling is an explicit statement that the endpoint is fixed; clear the
    // failure streak so the UI doesn't keep showing a stale red badge until the
    // next event happens to arrive.
    if (patch.status === "enabled") {
      values.consecutiveFailures = 0;
      values.lastError = null;
    }
  }

  const [row] = await db
    .update(webhookEndpoints)
    .set(values)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.accountId, accountId)))
    .returning();
  return row;
}

/**
 * Mint a new signing secret. The old one stops being valid immediately — we sign
 * with one secret, not two — so the docs tell you to deploy the new secret to a
 * receiver that accepts either, then rotate, then drop the old one.
 */
export async function rotateEndpointSecret(
  db: Db,
  accountId: string,
  id: string,
): Promise<string | undefined> {
  const secret = generateWebhookSecret();
  const [row] = await db
    .update(webhookEndpoints)
    .set({ secretEnc: await encryptSecret(secret), updatedAt: nowIso() })
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.accountId, accountId)))
    .returning({ id: webhookEndpoints.id });
  return row ? secret : undefined;
}

export async function deleteEndpoint(db: Db, accountId: string, id: string): Promise<boolean> {
  const [row] = await db
    .delete(webhookEndpoints)
    .where(and(eq(webhookEndpoints.id, id), eq(webhookEndpoints.accountId, accountId)))
    .returning({ id: webhookEndpoints.id });
  if (!row) return false;
  // Deliveries are account-scoped rows that outlive nothing useful once their
  // endpoint is gone, and the log UI joins through the endpoint.
  await db.delete(webhookDeliveries).where(
    and(eq(webhookDeliveries.accountId, accountId), eq(webhookDeliveries.endpointId, id)),
  );
  return true;
}

/** The plaintext signing secret, for display in the UI and for signing in the worker. */
export async function endpointSecret(endpoint: Pick<WebhookEndpoint, "secretEnc">): Promise<string> {
  return decryptSecret(endpoint.secretEnc);
}

// --- Delivery log -----------------------------------------------------------

export async function listDeliveries(
  db: Db,
  accountId: string,
  opts: { endpointId?: string; limit: number; offset: number },
): Promise<WebhookDelivery[]> {
  return db
    .select()
    .from(webhookDeliveries)
    .where(
      and(
        eq(webhookDeliveries.accountId, accountId),
        ...(opts.endpointId ? [eq(webhookDeliveries.endpointId, opts.endpointId)] : []),
      ),
    )
    .orderBy(desc(webhookDeliveries.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);
}

/**
 * Queue a finished delivery for another attempt. Resets the ledger rather than
 * appending, so the row keeps meaning "the current state of getting this event
 * to this endpoint"; the stored payload is reused verbatim, so the receiver sees
 * the original event with a signature that still verifies.
 *
 * Only terminal rows are resendable — a `pending`/`delivering` row is already on
 * its way, and re-queueing it would race the attempt in flight.
 */
export async function resendDelivery(
  db: Db,
  accountId: string,
  id: string,
): Promise<WebhookDelivery | undefined> {
  const now = nowIso();
  const [row] = await db
    .update(webhookDeliveries)
    .set({
      status: "pending",
      attempt: 0,
      nextAttemptAt: now,
      lockedAt: null,
      error: null,
      responseStatus: null,
      responseBody: null,
      durationMs: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(webhookDeliveries.id, id),
        eq(webhookDeliveries.accountId, accountId),
        inArray(webhookDeliveries.status, ["succeeded", "failed"]),
      ),
    )
    .returning();
  return row;
}
