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

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export async function POST(req: NextRequest) {
  let payload;
  try {
    payload = await validator.validate(await req.text());
  } catch {
    return new Response("Invalid SNS signature", { status: 403 });
  }

  // Optional topic allowlist to reject messages from unexpected topics.
  const expectedTopic = process.env.SES_SNS_TOPIC_ARN;
  if (expectedTopic && payload.TopicArn !== expectedTopic) {
    return new Response("Unexpected topic", { status: 403 });
  }

  // Confirm the subscription on first handshake.
  if (payload.Type === "SubscriptionConfirmation") {
    if (payload.SubscribeURL) {
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
  await db.insert(emailEvents).values({
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
  });
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
