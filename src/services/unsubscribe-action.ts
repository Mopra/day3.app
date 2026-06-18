import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { campaignRecipients, emailEvents, subscribers } from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { addSuppression } from "./suppression";
import type { UnsubscribeTokenPayload } from "./unsubscribe";

// The DB effects of an unsubscribe: mark the subscriber, suppress the address,
// mark the campaign recipient, and record the event. Pure db-in/out so both the
// public route handler and the tests can drive it without HTTP.
export async function applyUnsubscribe(
  db: Db,
  payload: UnsubscribeTokenPayload,
): Promise<void> {
  const now = nowIso();

  const subscriber = await db.query.subscribers.findFirst({
    where: and(
      eq(subscribers.id, payload.subscriberId),
      eq(subscribers.accountId, payload.accountId),
    ),
  });
  if (subscriber) {
    await db
      .update(subscribers)
      .set({ status: "unsubscribed", unsubscribedAt: now, updatedAt: now })
      .where(eq(subscribers.id, subscriber.id));
  }

  await addSuppression(db, {
    accountId: payload.accountId,
    email: payload.email,
    reason: "unsubscribe",
    source: payload.campaignId ?? "unsubscribe-page",
  });

  if (payload.campaignRecipientId) {
    await db
      .update(campaignRecipients)
      .set({ status: "unsubscribed", unsubscribedAt: now, updatedAt: now })
      .where(
        and(
          eq(campaignRecipients.id, payload.campaignRecipientId),
          eq(campaignRecipients.accountId, payload.accountId),
        ),
      );
  }

  await db.insert(emailEvents).values({
    id: newId("evt"),
    accountId: payload.accountId,
    campaignId: payload.campaignId ?? null,
    campaignRecipientId: payload.campaignRecipientId ?? null,
    eventType: "unsubscribe",
    email: payload.email,
    provider: "ses",
    createdAt: now,
  });
}
