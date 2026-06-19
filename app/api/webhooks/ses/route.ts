import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import SnsPayloadValidator from "sns-payload-validator";
import { getDb, type Db } from "@/db/client";
import { campaignRecipients, emailEvents, subscribers, type CampaignRecipient } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { addSuppression } from "@/services/suppression";
import { enforceAccountHealth } from "@/services/health";

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
function warnReject(reason: string, fields: Record<string, string | undefined> = {}): void {
  console.warn(JSON.stringify({ level: "warn", at: "ses-webhook", reason, ...fields }));
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
        console.error("[ses-webhook] subscription confirm failed:", err);
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
  // providerMessageId is the SES MessageId we stored at send time.
  const recipient = await db.query.campaignRecipients.findFirst({
    where: eq(campaignRecipients.providerMessageId, messageId),
  });
  if (!recipient) return new Response("OK", { status: 200 });

  const now = nowIso();

  if (eventType === "delivery") {
    await recordEvent(db, recipient, "delivery", messageId, payload.Message, now);
    await db
      .update(campaignRecipients)
      .set({ status: "delivered", deliveredAt: now, updatedAt: now })
      .where(and(eq(campaignRecipients.id, recipient.id), eq(campaignRecipients.status, "sent")));
    return new Response("OK", { status: 200 });
  }

  if (eventType === "bounce") {
    await recordEvent(db, recipient, "bounce", messageId, payload.Message, now);
    // Only permanent (hard) bounces suppress; transient (soft) bounces are
    // recorded but don't pull the address from the list.
    const bounceType = str(rec(event.bounce).bounceType);
    if (bounceType === "Permanent" || bounceType === "Undetermined") {
      await applyHardFailure(db, recipient, "bounced", "hard_bounce", now);
    }
    return new Response("OK", { status: 200 });
  }

  if (eventType === "complaint") {
    await recordEvent(db, recipient, "complaint", messageId, payload.Message, now);
    await applyHardFailure(db, recipient, "complained", "complaint", now);
    return new Response("OK", { status: 200 });
  }

  // send / open / click / reject / etc. — not modelled in the MVP.
  return new Response("OK", { status: 200 });
}

async function recordEvent(
  db: Db,
  recipient: CampaignRecipient,
  eventType: "delivery" | "bounce" | "complaint",
  messageId: string,
  rawMessage: string,
  now: string,
): Promise<void> {
  // SNS is at-least-once: a redelivered notification must not insert a second
  // row. The unique index on (providerMessageId, eventType) makes this a no-op.
  await db
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
    .onConflictDoNothing();
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
