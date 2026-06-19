import { eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findSubscriber } from "@/api/finders";
import { emailEvents, subscribers } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { addSuppression } from "@/services/suppression";

export const POST = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const subscriber = await findSubscriber(db, account.id, id);
  if (!subscriber) throw new HttpError(404, "Not found");

  const now = nowIso();
  await db
    .update(subscribers)
    .set({ status: "unsubscribed", unsubscribedAt: now, updatedAt: now })
    .where(eq(subscribers.id, subscriber.id));
  await addSuppression(db, {
    accountId: subscriber.accountId,
    email: subscriber.email,
    reason: "manual",
    source: "dashboard",
  });
  await db.insert(emailEvents).values({
    id: newId("evt"),
    accountId: subscriber.accountId,
    eventType: "unsubscribe",
    email: subscriber.email,
    provider: "ses",
    payloadJson: JSON.stringify({ source: "dashboard" }),
    createdAt: now,
  });
  return json({ ok: true });
});
