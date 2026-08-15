import { lookup as dnsLookup } from "node:dns";
import { request as httpsRequest } from "node:https";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "../../db/client";
import { webhookDeliveries, webhookEndpoints, type WebhookEndpoint } from "../../db/schema";
import { nowIso } from "../../lib/ids";
import { logger } from "../../lib/logger";
import {
  DELIVERY_ATTEMPT_HEADER,
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  SIGNATURE_HEADER,
  signatureHeader,
} from "../../lib/webhook-signature";
import { isPublicAddress, URL_REJECTION_MESSAGES, validateWebhookUrl } from "../../lib/webhook-url";
import {
  endpointSecret,
  WEBHOOK_MAX_ATTEMPTS,
  WEBHOOK_RESPONSE_SNIPPET_BYTES,
  WEBHOOK_RETRY_DELAYS_MS,
  WEBHOOK_TIMEOUT_MS,
} from "../../services/webhooks";
import type { JobQueue } from "../messages";

// One outbound webhook delivery attempt.
//
// Idempotent the same way every other send in this codebase is: the row's
// status is the ledger, and only a `pending` row is claimable. A retried job
// (BullMQ redelivery, a duplicate enqueue from the cron sweep) finds the row in
// `delivering`/`succeeded` and returns without making a second request.
//
// The handler does NOT throw on a failing endpoint — a receiver returning 500 is
// the normal case this system exists to survive, not a job failure. It records
// the attempt and schedules the next one itself, because the retry schedule
// spans hours (see WEBHOOK_RETRY_DELAYS_MS) and is a product promise, not
// BullMQ's exponential backoff. It throws only when *our* infrastructure fails
// (a DB write), so BullMQ retries and, past that, dead-letters it visibly.

export type DeliverWebhookDeps = { db: Db; queue: JobQueue };

export async function deliverWebhook(
  message: { deliveryId: string; accountId: string },
  deps: DeliverWebhookDeps,
): Promise<void> {
  const { db, queue } = deps;
  const now = nowIso();

  // Claim. The guarded UPDATE is what makes concurrent/duplicate jobs safe:
  // exactly one of them flips pending → delivering and gets the row back.
  const [delivery] = await db
    .update(webhookDeliveries)
    .set({ status: "delivering", lockedAt: now, updatedAt: now })
    .where(
      and(
        eq(webhookDeliveries.id, message.deliveryId),
        eq(webhookDeliveries.accountId, message.accountId),
        eq(webhookDeliveries.status, "pending"),
      ),
    )
    .returning();
  if (!delivery) return;

  const [endpoint] = await db
    .select()
    .from(webhookEndpoints)
    .where(
      and(
        eq(webhookEndpoints.id, delivery.endpointId),
        eq(webhookEndpoints.accountId, message.accountId),
      ),
    )
    .limit(1);

  // Deleted or disabled between emission and delivery. Terminal, and not a
  // failure of the endpoint — don't touch its health counters.
  if (!endpoint) {
    await finalize(db, delivery.id, { status: "failed", error: "endpoint no longer exists" });
    return;
  }
  if (endpoint.status !== "enabled") {
    await finalize(db, delivery.id, { status: "failed", error: "endpoint is disabled" });
    return;
  }

  const attempt = delivery.attempt + 1;
  const result = await attemptDelivery(endpoint, {
    payload: delivery.payloadJson,
    eventId: delivery.eventId,
    eventType: delivery.eventType,
    attempt,
  });

  if (result.ok) {
    await finalize(db, delivery.id, {
      status: "succeeded",
      attempt,
      responseStatus: result.status,
      responseBody: result.body,
      durationMs: result.durationMs,
      deliveredAt: nowIso(),
    });
    await db
      .update(webhookEndpoints)
      .set({ lastSuccessAt: nowIso(), consecutiveFailures: 0, lastError: null, updatedAt: nowIso() })
      .where(eq(webhookEndpoints.id, endpoint.id));
    return;
  }

  // Failure. `retryable: false` is reserved for problems no amount of waiting
  // fixes — today that is a URL that fails the SSRF guard, which means the
  // endpoint's configuration is wrong, not that the receiver is down.
  const delay = result.retryable ? WEBHOOK_RETRY_DELAYS_MS[attempt - 1] : undefined;
  const exhausted = delay === undefined || attempt >= WEBHOOK_MAX_ATTEMPTS;

  await finalize(db, delivery.id, {
    status: exhausted ? "failed" : "pending",
    attempt,
    responseStatus: result.status,
    responseBody: result.body,
    durationMs: result.durationMs,
    error: result.error,
    nextAttemptAt: exhausted ? null : new Date(Date.now() + delay).toISOString(),
  });

  await db
    .update(webhookEndpoints)
    .set({
      lastFailureAt: nowIso(),
      lastError: result.error.slice(0, 500),
      // Counts consecutive *failed deliveries*, not attempts — one flaky event
      // that eventually succeeds shouldn't read the same as an endpoint that has
      // been down all day. Only bumped on the terminal attempt.
      ...(exhausted ? { consecutiveFailures: sql`${webhookEndpoints.consecutiveFailures} + 1` } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(webhookEndpoints.id, endpoint.id));

  if (!exhausted) {
    // Best-effort: if this enqueue is lost, the row is `pending` with a
    // nextAttemptAt in the past and the cron sweep re-queues it.
    try {
      await queue.send(
        { type: "deliver_webhook", deliveryId: delivery.id, accountId: message.accountId },
        { delayMs: delay },
      );
    } catch (err) {
      void logger.reportError("webhook retry enqueue failed (cron sweep will recover)", err, {
        accountId: message.accountId,
        entityId: delivery.id,
      });
    }
  }
}

async function finalize(
  db: Db,
  id: string,
  values: Partial<typeof webhookDeliveries.$inferInsert>,
): Promise<void> {
  await db
    .update(webhookDeliveries)
    .set({ ...values, lockedAt: null, updatedAt: nowIso() })
    .where(eq(webhookDeliveries.id, id));
}

// --- The HTTP call ----------------------------------------------------------

type AttemptResult =
  | { ok: true; status: number; body: string | null; durationMs: number }
  | {
      ok: false;
      status: number | null;
      body: string | null;
      durationMs: number;
      error: string;
      retryable: boolean;
    };

async function attemptDelivery(
  endpoint: WebhookEndpoint,
  ctx: { payload: string; eventId: string; eventType: string; attempt: number },
): Promise<AttemptResult> {
  const startedAt = Date.now();

  // Re-validate at delivery time: the URL was checked when it was saved, but the
  // rules can tighten, and a row can predate them.
  const validated = validateWebhookUrl(endpoint.url);
  if (!validated.ok) {
    return {
      ok: false,
      status: null,
      body: null,
      durationMs: Date.now() - startedAt,
      error: URL_REJECTION_MESSAGES[validated.reason],
      retryable: false,
    };
  }

  let secret: string;
  try {
    secret = await endpointSecret(endpoint);
  } catch (err) {
    // A key rotated out from under a stored secret. Retrying won't help, and the
    // error must not leak key material into the delivery log the tenant reads.
    void logger.reportError("webhook secret decryption failed", err, { entityId: endpoint.id });
    return {
      ok: false,
      status: null,
      body: null,
      durationMs: Date.now() - startedAt,
      error: "signing secret could not be read — rotate the endpoint's secret",
      retryable: false,
    };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const url = new URL(validated.url);

  try {
    const res = await postJson(url, ctx.payload, {
      [SIGNATURE_HEADER]: signatureHeader(secret, timestamp, ctx.payload),
      [EVENT_ID_HEADER]: ctx.eventId,
      [EVENT_TYPE_HEADER]: ctx.eventType,
      [DELIVERY_ATTEMPT_HEADER]: String(ctx.attempt),
    });
    const durationMs = Date.now() - startedAt;

    if (res.status >= 200 && res.status < 300) {
      return { ok: true, status: res.status, body: res.body, durationMs };
    }
    return {
      ok: false,
      status: res.status,
      body: res.body,
      durationMs,
      error: `endpoint responded ${res.status}`,
      // A 3xx counts as a failure: we deliberately do not follow redirects (a
      // followed redirect is an SSRF bypass), so the receiver must be configured
      // with its final URL.
      retryable: true,
    };
  } catch (err) {
    const durationMs = Date.now() - startedAt;
    const blocked = err instanceof BlockedAddressError;
    return {
      ok: false,
      status: null,
      body: null,
      durationMs,
      error: blocked ? err.message : `request failed: ${err instanceof Error ? err.message : String(err)}`,
      retryable: !blocked,
    };
  }
}

class BlockedAddressError extends Error {
  constructor(host: string, address: string) {
    super(`${host} resolves to ${address}, which is not a public address`);
    this.name = "BlockedAddressError";
  }
}

// The SSRF guard that actually matters: net.connect resolves the hostname
// through this, so the address we validate is the address the socket uses.
// Checking with a separate dns.lookup before fetch() would leave a window in
// which the name re-resolves to 169.254.169.254 between our check and the
// connection (DNS rebinding).
function guardedLookup(host: string): Parameters<typeof httpsRequest>[1]["lookup"] {
  return ((hostname, options, callback) => {
    const opts = typeof options === "number" ? { family: options } : { ...options };
    // Ask for every address so a name that resolves to one public and one
    // private address can't have the private one silently chosen.
    dnsLookup(hostname, { ...opts, all: true }, (err, addresses) => {
      if (err) return callback(err, "", 4);
      const list = Array.isArray(addresses) ? addresses : [addresses];
      const bad = list.find((a) => !isPublicAddress(a.address, a.family === 6 ? 6 : 4));
      if (bad) return callback(new BlockedAddressError(host, bad.address), "", 4);
      if (list.length === 0) return callback(new Error(`${host} did not resolve`), "", 4);
      // Honour the caller's `all` contract — Node passes all:true in some
      // versions and expects the array form back.
      const wantsAll = typeof options === "object" && options !== null && options.all === true;
      return wantsAll
        ? (callback as unknown as (e: null, a: typeof list) => void)(null, list)
        : callback(null, list[0].address, list[0].family);
    });
  }) as Parameters<typeof httpsRequest>[1]["lookup"];
}

function postJson(
  url: URL,
  body: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string | null }> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method: "POST",
        // Byte length, not character count — a multibyte payload with a short
        // Content-Length is a request-smuggling shape, and the receiver would
        // see truncated JSON that fails signature verification.
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": "Day3-Webhooks/1.0 (+https://day3.app)",
          accept: "*/*",
          ...headers,
        },
        lookup: guardedLookup(url.hostname),
        // node:https does not follow redirects, which is exactly what we want.
      },
      (res) => {
        // Read a bounded prefix of the response so a receiver streaming
        // gigabytes can't exhaust the worker; destroy the socket once we have
        // enough rather than draining politely.
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          if (size < WEBHOOK_RESPONSE_SNIPPET_BYTES) {
            chunks.push(chunk);
            size += chunk.length;
          } else {
            res.destroy();
          }
        });
        const finish = () => {
          const text = Buffer.concat(chunks)
            .subarray(0, WEBHOOK_RESPONSE_SNIPPET_BYTES)
            .toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: text.length > 0 ? text : null });
        };
        res.on("end", finish);
        res.on("close", finish);
        res.on("error", finish);
      },
    );

    req.setTimeout(WEBHOOK_TIMEOUT_MS, () => {
      req.destroy(new Error(`timed out after ${WEBHOOK_TIMEOUT_MS}ms`));
    });
    req.on("error", reject);
    req.end(body);
  });
}
