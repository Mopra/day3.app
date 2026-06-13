import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { emailEvents, subscribers } from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { addSuppression } from "../services/suppression";
import { requireAccount } from "./middleware";
import type { AppContext } from "./context";

export const subscriberRoutes = new Hono<AppContext>();
subscriberRoutes.use("*", requireAccount);

async function findSubscriber(c: { get: (k: "db" | "account") => unknown }, id: string) {
  const db = c.get("db") as AppContext["Variables"]["db"];
  const account = c.get("account") as AppContext["Variables"]["account"];
  return db.query.subscribers.findFirst({
    where: and(eq(subscribers.id, id), eq(subscribers.accountId, account.id)),
  });
}

subscriberRoutes.post("/:id/unsubscribe", async (c) => {
  const subscriber = await findSubscriber(c, c.req.param("id"));
  if (!subscriber) return c.json({ error: "Not found" }, 404);

  const db = c.get("db");
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
    provider: "cloudflare",
    payloadJson: JSON.stringify({ source: "dashboard" }),
    createdAt: now,
  });
  return c.json({ ok: true });
});

subscriberRoutes.delete("/:id", async (c) => {
  const subscriber = await findSubscriber(c, c.req.param("id"));
  if (!subscriber) return c.json({ error: "Not found" }, 404);
  await c.get("db").delete(subscribers).where(eq(subscribers.id, subscriber.id));
  return c.json({ ok: true });
});
