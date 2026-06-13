import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { createDb } from "../db/client";
import {
  accounts,
  campaignRecipients,
  emailEvents,
  subscribers,
} from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { applySubscriptionEvent } from "../services/accounts";
import { addSuppression } from "../services/suppression";
import { enforceAccountHealth } from "../services/health";
import type { AppContext } from "./context";

export const webhookRoutes = new Hono<AppContext>();

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

function epochToIso(v: unknown): string | null {
  if (typeof v !== "number") return null;
  // Clerk uses ms epochs.
  return new Date(v).toISOString();
}

webhookRoutes.post("/clerk", async (c) => {
  if (!c.env.CLERK_WEBHOOK_SIGNING_SECRET) {
    return c.text("Missing CLERK_WEBHOOK_SIGNING_SECRET", 500);
  }

  let evt: { type: string; data: unknown };
  try {
    evt = await verifyWebhook(c.req.raw, {
      signingSecret: c.env.CLERK_WEBHOOK_SIGNING_SECRET,
    });
  } catch {
    return c.text("Webhook verification failed", 400);
  }

  const db = createDb(c.env.DB);
  const data = rec(evt.data);

  switch (evt.type) {
    case "organization.updated": {
      const orgId = str(data.id);
      const name = str(data.name);
      if (orgId && name) {
        await db
          .update(accounts)
          .set({ name, updatedAt: nowIso() })
          .where(eq(accounts.clerkOrgId, orgId));
      }
      break;
    }
    case "organization.deleted": {
      const orgId = str(data.id);
      if (orgId) {
        await db
          .update(accounts)
          .set({
            subscriptionStatus: "inactive",
            sendingEnabled: 0,
            updatedAt: nowIso(),
          })
          .where(eq(accounts.clerkOrgId, orgId));
      }
      break;
    }
    // Billing lifecycle. "active" grants the plan; "ended"/"pastDue" revoke
    // it; "canceled" keeps access until the period ends (the "ended" event
    // follows). Accounts are created lazily on first dashboard load, so a
    // missing account here is fine.
    case "subscriptionItem.active":
    case "subscriptionItem.pastDue":
    case "subscriptionItem.ended": {
      const orgId = str(rec(data.payer).organization_id);
      const planSlug = str(rec(data.plan).slug);
      if (orgId) {
        await applySubscriptionEvent(db, {
          clerkOrgId: orgId,
          planSlug,
          active: evt.type === "subscriptionItem.active",
          periodStart: epochToIso(data.period_start),
          periodEnd: epochToIso(data.period_end),
        });
      }
      break;
    }
    default:
      // organization.created is handled lazily; membership events are not
      // needed locally in the MVP.
      break;
  }

  return c.text("OK", 200);
});

// Cloudflare Email Service event ingestion. Provider webhook support is still
// evolving — this route accepts a simple JSON shape so events can be tested
// locally and wired to the real source later:
//   { "type": "bounce" | "complaint" | "delivery",
//     "provider_message_id": "...", "email": "..." }
webhookRoutes.post("/cloudflare-email", async (c) => {
  const secret = c.env.CF_EMAIL_WEBHOOK_SECRET;
  if (secret && c.req.header("x-webhook-secret") !== secret) {
    return c.text("Unauthorized", 401);
  }

  const payload = rec(await c.req.json().catch(() => null));
  const type = str(payload.type);
  const providerMessageId = str(payload.provider_message_id) ?? str(payload.messageId);
  if (!type || !["bounce", "complaint", "delivery"].includes(type)) {
    return c.json({ error: "Unsupported event type" }, 400);
  }
  if (!providerMessageId) {
    return c.json({ error: "provider_message_id is required" }, 400);
  }

  const db = createDb(c.env.DB);
  const recipient = await db.query.campaignRecipients.findFirst({
    where: eq(campaignRecipients.providerMessageId, providerMessageId),
  });
  if (!recipient) {
    return c.json({ error: "No recipient found for that message id" }, 404);
  }

  const now = nowIso();
  await db.insert(emailEvents).values({
    id: newId("evt"),
    accountId: recipient.accountId,
    campaignId: recipient.campaignId,
    campaignRecipientId: recipient.id,
    eventType: type === "delivery" ? "delivery" : type === "bounce" ? "bounce" : "complaint",
    email: recipient.email,
    provider: "cloudflare",
    providerMessageId,
    payloadJson: JSON.stringify(payload),
    createdAt: now,
  });

  if (type === "delivery") {
    await db
      .update(campaignRecipients)
      .set({ status: "delivered", deliveredAt: now, updatedAt: now })
      .where(and(eq(campaignRecipients.id, recipient.id), eq(campaignRecipients.status, "sent")));
  } else {
    const isBounce = type === "bounce";
    await db
      .update(campaignRecipients)
      .set(
        isBounce
          ? { status: "bounced", bouncedAt: now, updatedAt: now }
          : { status: "complained", complainedAt: now, updatedAt: now },
      )
      .where(eq(campaignRecipients.id, recipient.id));

    if (recipient.subscriberId) {
      await db
        .update(subscribers)
        .set({ status: isBounce ? "bounced" : "complained", updatedAt: now })
        .where(eq(subscribers.id, recipient.subscriberId));
    }
    await addSuppression(db, {
      accountId: recipient.accountId,
      email: recipient.email,
      reason: isBounce ? "hard_bounce" : "complaint",
      source: "cloudflare-email-webhook",
    });

    await enforceAccountHealth(db, recipient.accountId);
  }

  return c.json({ ok: true });
});
