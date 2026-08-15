import type { NextRequest } from "next/server";
import { and, eq, inArray } from "drizzle-orm";
import SnsPayloadValidator from "sns-payload-validator";
import { getDb, type Db } from "@/db/client";
import {
  campaignRecipients,
  emailEvents,
  subscribers,
  transactionalEmails,
  type CampaignRecipient,
  type TransactionalEmail,
} from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { addSuppression } from "@/services/suppression";
import { enforceAccountHealth } from "@/services/health";
import { emitWebhookEvent } from "@/services/webhook-events";
import { logger } from "@/lib/logger";

// SES → configuration set → SNS topic → HTTPS subscription posts here. The
// validator verifies the SNS signature (SigV1/SigV2) against the AWS signing
// cert and rejects non-AWS SigningCertURLs — no shared secret needed.
const validator = new SnsPayloadValidator();

// This route is unauthenticated by design (SNS can't present a bearer token), so
// it carries its own abuse hardening: a body cap to bound parsing work, a
// mandatory topic allowlist (SES_SNS_TOPIC_ARN, required in prod by env.ts), and
// a host allowlist on SubscribeURL to defang SSRF via a forged handshake.
//
// A legitimate SNS notification envelope is a few KB; SES event payloads are
// well under this. 256 KiB leaves generous headroom while rejecting anything
// large enough to be an abuse attempt before we spend cycles validating it.
const MAX_BODY_BYTES = 256 * 1024;

// SNS confirmation handshakes only ever point at the regional SNS control plane.
// We require the SubscribeURL host to be exactly sns.<region>.amazonaws.com so a
// forged SubscriptionConfirmation can't coerce a fetch to an arbitrary host.
// (The validator's cert check is the primary defense; this is defense in depth.)
const SNS_HOST_RE = /^sns\.[a-z0-9-]+\.amazonaws\.com$/;

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

// Structured rejection log. Never includes signature, secret, or body material —
// only coarse, non-sensitive metadata useful for spotting abuse in aggregate.
// Routed through the shared logger so rejections share the JSON shape +
// redaction the rest of the service uses.
function warnReject(reason: string, fields: Record<string, string | undefined> = {}): void {
  logger.warn("ses-webhook rejected", { reason, ...fields });
}

function isAllowedSubscribeUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return url.protocol === "https:" && SNS_HOST_RE.test(url.hostname);
}

export async function POST(req: NextRequest) {
  const body = await req.text();

  // Reject oversized bodies before handing them to the signature validator.
  if (body.length > MAX_BODY_BYTES) {
    warnReject("body_too_large", { bytes: String(body.length) });
    return new Response("Payload too large", { status: 413 });
  }

  let payload;
  try {
    payload = await validator.validate(body);
  } catch {
    // Forged / unverifiable signature. The validator already declined to fetch a
    // non-AWS SigningCertURL; we only log a non-sensitive marker here.
    warnReject("invalid_signature");
    return new Response("Invalid SNS signature", { status: 403 });
  }

  // Topic allowlist. SES_SNS_TOPIC_ARN is required in production (env.ts), so
  // this check is never silently skipped where it matters.
  const expectedTopic = process.env.SES_SNS_TOPIC_ARN;
  if (expectedTopic && payload.TopicArn !== expectedTopic) {
    warnReject("topic_mismatch", {
      type: str(payload.Type),
      received: str(payload.TopicArn),
    });
    return new Response("Unexpected topic", { status: 403 });
  }

  // Confirm the subscription on first handshake.
  if (payload.Type === "SubscriptionConfirmation") {
    if (payload.SubscribeURL) {
      // SSRF guard: only fetch SubscribeURLs on the regional SNS host.
      if (!isAllowedSubscribeUrl(payload.SubscribeURL)) {
        warnReject("subscribe_url_host_rejected");
        return new Response("Invalid SubscribeURL", { status: 403 });
      }
      try {
        await fetch(payload.SubscribeURL);
      } catch (err) {
        void logger.reportError("ses-webhook subscription confirm failed", err);
      }
    }
    return new Response("OK", { status: 200 });
  }
  if (payload.Type !== "Notification") {
    return new Response("OK", { status: 200 });
  }

  let event: Rec;
  try {
    event = rec(JSON.parse(payload.Message));
  } catch {
    return new Response("Invalid event JSON", { status: 400 });
  }

  // Config-set event publishing uses `eventType`; legacy SES notifications use
  // `notificationType`.
  const eventType = (str(event.eventType) ?? str(event.notificationType) ?? "").toLowerCase();
  const messageId = str(rec(event.mail).messageId);
  if (!messageId) return new Response("OK", { status: 200 });

  const db = getDb();
  // providerMessageId is the SES MessageId we stored at send time. A message is
  // either a campaign send (campaign_recipients) or a transactional API send
  // (transactional_emails) — check the campaign ledger first (higher volume).
  const recipient = await db.query.campaignRecipients.findFirst({
    where: eq(campaignRecipients.providerMessageId, messageId),
  });
  if (!recipient) {
    const txEmail = await db.query.transactionalEmails.findFirst({
      where: eq(transactionalEmails.providerMessageId, messageId),
    });
    if (txEmail) return handleTransactionalEvent(db, txEmail, eventType, messageId, payload.Message, event);
    return new Response("OK", { status: 200 });
  }

  const now = nowIso();

  // Outbound webhooks ride on the recorded-event id, and only when the insert
  // actually inserted: SNS is at-least-once, so emitting on every notification
  // would replay the event at the customer's endpoint on each redelivery.
  const campaignSource = {
    kind: "campaign" as const,
    campaignId: recipient.campaignId,
    recipientId: recipient.id,
    subscriberId: recipient.subscriberId,
    email: recipient.email,
  };

  if (eventType === "delivery") {
    const eventId = await recordEvent(db, recipient, "delivery", messageId, payload.Message, now);
    await db
      .update(campaignRecipients)
      .set({ status: "delivered", deliveredAt: now, updatedAt: now })
      .where(and(eq(campaignRecipients.id, recipient.id), eq(campaignRecipients.status, "sent")));
    if (eventId) {
      await emitWebhookEvent(db, {
        type: "email.delivered",
        accountId: recipient.accountId,
        eventId,
        source: campaignSource,
        subject: null,
        providerMessageId: messageId,
      });
    }
    return new Response("OK", { status: 200 });
  }

  if (eventType === "bounce") {
    const eventId = await recordEvent(db, recipient, "bounce", messageId, payload.Message, now);
    // Only permanent (hard) bounces suppress; transient (soft) bounces are
    // recorded but don't pull the address from the list.
    const bounce = rec(event.bounce);
    const bounceType = str(bounce.bounceType);
    if (bounceType === "Permanent" || bounceType === "Undetermined") {
      await applyHardFailure(db, recipient, "bounced", "hard_bounce", now);
    }
    // Emitted for transient bounces too — the receiver gets bounce_type and
    // decides. Suppressing on a soft bounce is our policy, not theirs.
    if (eventId) {
      await emitWebhookEvent(db, {
        type: "email.bounced",
        accountId: recipient.accountId,
        eventId,
        source: campaignSource,
        subject: null,
        providerMessageId: messageId,
        bounceType: bounceType ?? null,
        bounceSubType: str(bounce.bounceSubType) ?? null,
      });
    }
    return new Response("OK", { status: 200 });
  }

  if (eventType === "complaint") {
    const eventId = await recordEvent(db, recipient, "complaint", messageId, payload.Message, now);
    await applyHardFailure(db, recipient, "complained", "complaint", now);
    if (eventId) {
      await emitWebhookEvent(db, {
        type: "email.complained",
        accountId: recipient.accountId,
        eventId,
        source: campaignSource,
        subject: null,
        providerMessageId: messageId,
      });
    }
    return new Response("OK", { status: 200 });
  }

  // send / open / click / reject / etc. — not modelled in the MVP.
  return new Response("OK", { status: 200 });
}

// Delivery lifecycle for a transactional (API) email. Mirrors the campaign
// path: record the event (dedupe-safe), advance the status, suppress hard
// failures, recompute account health.
//
// One transactional message can carry up to 50 To addresses, and SES emits ONE
// notification PER affected recipient, all sharing the same mail.messageId. So
// everything here is per-address, not per-message:
//   - events are recorded one row per reported address (the dedupe key includes
//     the address, so a redelivery is still a no-op but recipient #2's bounce
//     isn't mistaken for a duplicate of #1's);
//   - suppression runs on every notification, keyed by the addresses THAT
//     notification reports. An early return on the message's aggregate status
//     would suppress only the first bounced address of fifty and leave the rest
//     mailable — the failure mode this shape exists to avoid.
// The message-level status flip and the health recompute are the only
// once-per-message steps, and both are already idempotent (guarded UPDATE /
// normal→paused transition).
async function handleTransactionalEvent(
  db: Db,
  email: TransactionalEmail,
  eventType: string,
  messageId: string,
  rawMessage: string,
  event: Rec,
): Promise<Response> {
  const now = nowIso();

  // Returns [address, newEventId] for the addresses this notification newly
  // recorded — redeliveries yield nothing, which is what keeps the outbound
  // webhook exactly-once per (address, event type).
  const record = async (
    type: "delivery" | "bounce" | "complaint",
    addresses: string[],
  ): Promise<Array<{ address: string; eventId: string }>> => {
    const fresh: Array<{ address: string; eventId: string }> = [];
    for (const address of addresses) {
      const inserted = await db
        .insert(emailEvents)
        .values({
          id: newId("evt"),
          accountId: email.accountId,
          transactionalEmailId: email.id,
          eventType: type,
          email: address,
          provider: "ses",
          providerMessageId: messageId,
          payloadJson: rawMessage,
          createdAt: now,
        })
        .onConflictDoNothing()
        .returning({ id: emailEvents.id });
      if (inserted[0]) fresh.push({ address, eventId: inserted[0].id });
    }
    return fresh;
  };

  // One webhook event per affected address, matching how SES reports them: a
  // 50-recipient message that bounces for three addresses is three events, not
  // one with an array — the receiver almost always wants to act per address.
  const emitPerAddress = async (
    fresh: Array<{ address: string; eventId: string }>,
    build: (address: string, eventId: string) => Parameters<typeof emitWebhookEvent>[1],
  ) => {
    for (const { address, eventId } of fresh) {
      await emitWebhookEvent(db, build(address, eventId));
    }
  };

  const txSource = (address: string) => ({
    kind: "transactional" as const,
    emailId: email.id,
    to: email.to,
    email: address,
  });

  if (eventType === "delivery") {
    const fresh = await record("delivery", reportedAddresses(rec(event.delivery).recipients, email));
    await db
      .update(transactionalEmails)
      .set({ status: "delivered", deliveredAt: now, updatedAt: now })
      .where(and(eq(transactionalEmails.id, email.id), eq(transactionalEmails.status, "sent")));
    await emitPerAddress(fresh, (address, eventId) => ({
      type: "email.delivered",
      accountId: email.accountId,
      eventId,
      source: txSource(address),
      subject: email.subject,
      providerMessageId: messageId,
    }));
    return new Response("OK", { status: 200 });
  }

  if (eventType === "bounce") {
    const bounce = rec(event.bounce);
    const addresses = reportedAddresses(bounce.bouncedRecipients, email);
    const fresh = await record("bounce", addresses);
    const bounceType = str(bounce.bounceType);
    await emitPerAddress(fresh, (address, eventId) => ({
      type: "email.bounced",
      accountId: email.accountId,
      eventId,
      source: txSource(address),
      subject: email.subject,
      providerMessageId: messageId,
      bounceType: bounceType ?? null,
      bounceSubType: str(bounce.bounceSubType) ?? null,
    }));
    if (bounceType === "Permanent" || bounceType === "Undetermined") {
      // Suppression FIRST and unconditionally: addSuppression is idempotent
      // (onConflictDoNothing), so a redelivery is free, and every notification's
      // own addresses get suppressed regardless of the message's status.
      for (const address of addresses) {
        await addSuppression(db, {
          accountId: email.accountId,
          email: address,
          reason: "hard_bounce",
          source: "ses-sns-webhook",
        });
      }
      const flipped = await db
        .update(transactionalEmails)
        .set({ status: "bounced", bouncedAt: now, updatedAt: now })
        .where(
          and(
            eq(transactionalEmails.id, email.id),
            inArray(transactionalEmails.status, ["sent", "delivered"]),
          ),
        )
        .returning({ id: transactionalEmails.id });
      // Health only on the transition — it's an account-wide aggregate query,
      // pointless to re-run for each of fifty recipients of one message.
      if (flipped.length > 0) await enforceAccountHealth(db, email.accountId);
    }
    return new Response("OK", { status: 200 });
  }

  if (eventType === "complaint") {
    const addresses = reportedAddresses(rec(event.complaint).complainedRecipients, email);
    const fresh = await record("complaint", addresses);
    await emitPerAddress(fresh, (address, eventId) => ({
      type: "email.complained",
      accountId: email.accountId,
      eventId,
      source: txSource(address),
      subject: email.subject,
      providerMessageId: messageId,
    }));
    for (const address of addresses) {
      await addSuppression(db, {
        accountId: email.accountId,
        email: address,
        reason: "complaint",
        source: "ses-sns-webhook",
      });
    }
    const flipped = await db
      .update(transactionalEmails)
      .set({ status: "complained", complainedAt: now, updatedAt: now })
      .where(
        and(
          eq(transactionalEmails.id, email.id),
          inArray(transactionalEmails.status, ["sent", "delivered", "bounced"]),
        ),
      )
      .returning({ id: transactionalEmails.id });
    if (flipped.length > 0) await enforceAccountHealth(db, email.accountId);
    return new Response("OK", { status: 200 });
  }

  return new Response("OK", { status: 200 });
}

// The addresses an SES event payload names ({emailAddress} objects), intersected
// with the message's own recipients as defense in depth; falls back to the full
// recipient list when the payload omits them (single-recipient messages, where
// the fallback is exact anyway).
function reportedAddresses(reported: unknown, email: TransactionalEmail): string[] {
  const own = new Set(email.to.map((e) => e.toLowerCase()));
  const fromPayload = Array.isArray(reported)
    ? [
        ...new Set(
          reported
            .map((r) =>
              typeof r === "string"
                ? r.toLowerCase()
                : str(rec(r).emailAddress)?.toLowerCase(),
            )
            .filter((e): e is string => !!e && own.has(e)),
        ),
      ]
    : [];
  return fromPayload.length > 0 ? fromPayload : email.to;
}

// Returns the new event's id, or null when this notification was a redelivery
// of one already recorded. That null is what keeps outbound webhooks
// exactly-once per real event — callers emit only on a non-null result.
async function recordEvent(
  db: Db,
  recipient: CampaignRecipient,
  eventType: "delivery" | "bounce" | "complaint",
  messageId: string,
  rawMessage: string,
  now: string,
): Promise<string | null> {
  // SNS is at-least-once: a redelivered notification must not insert a second
  // row. The unique index on (providerMessageId, eventType) makes this a no-op.
  const inserted = await db
    .insert(emailEvents)
    .values({
      id: newId("evt"),
      accountId: recipient.accountId,
      campaignId: recipient.campaignId,
      campaignRecipientId: recipient.id,
      eventType,
      email: recipient.email,
      provider: "ses",
      providerMessageId: messageId,
      payloadJson: rawMessage,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: emailEvents.id });
  return inserted[0]?.id ?? null;
}

// Mirrors the old provider webhook: mark the recipient + subscriber, suppress the
// address, and recompute account health (which may auto-pause the account).
async function applyHardFailure(
  db: Db,
  recipient: CampaignRecipient,
  kind: "bounced" | "complained",
  reason: "hard_bounce" | "complaint",
  now: string,
): Promise<void> {
  // Idempotent under SNS redelivery: once the recipient is already in the target
  // terminal status, suppression and health enforcement have already run, so
  // re-running them would only re-trigger health recomputation. Bail early.
  if (recipient.status === kind) return;

  await db
    .update(campaignRecipients)
    .set(
      kind === "bounced"
        ? { status: "bounced", bouncedAt: now, updatedAt: now }
        : { status: "complained", complainedAt: now, updatedAt: now },
    )
    .where(eq(campaignRecipients.id, recipient.id));

  if (recipient.subscriberId) {
    await db
      .update(subscribers)
      .set({ status: kind, updatedAt: now })
      .where(eq(subscribers.id, recipient.subscriberId));
  }

  await addSuppression(db, {
    accountId: recipient.accountId,
    email: recipient.email,
    reason,
    source: "ses-sns-webhook",
  });

  await enforceAccountHealth(db, recipient.accountId);
}
