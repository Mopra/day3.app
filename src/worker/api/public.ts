import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { createDb } from "../db/client";
import {
  accounts,
  campaignRecipients,
  emailEvents,
  subscribers,
} from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { verifyUnsubscribeToken } from "../services/unsubscribe";
import { addSuppression } from "../services/suppression";
import { parseJson } from "./validate";
import type { AppContext } from "./context";

export const publicRoutes = new Hono<AppContext>();

publicRoutes.get("/unsubscribe", async (c) => {
  const token = c.req.query("token") ?? "";
  const payload = await verifyUnsubscribeToken(token, c.env.UNSUBSCRIBE_SECRET);
  if (!payload) return c.json({ error: "Invalid or expired link" }, 400);

  const db = createDb(c.env.DB);
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, payload.accountId),
  });
  return c.json({ email: payload.email, companyName: account?.name ?? "this sender" });
});

const ConfirmSchema = z.object({ token: z.string().min(1) });

async function performUnsubscribe(
  db: ReturnType<typeof createDb>,
  payload: NonNullable<Awaited<ReturnType<typeof verifyUnsubscribeToken>>>,
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
    provider: "cloudflare",
    createdAt: now,
  });
}

publicRoutes.post("/unsubscribe", async (c) => {
  // Support both the JSON body from the SPA and the form-encoded one-click
  // List-Unsubscribe-Post (RFC 8058) flow, which posts to the same URL the
  // token appears in.
  let token = c.req.query("token") ?? "";
  if (!token) {
    const contentType = c.req.header("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const parsed = await parseJson(c, ConfirmSchema);
      if (!parsed.ok) return parsed.response;
      token = parsed.data.token;
    }
  }

  const payload = await verifyUnsubscribeToken(token, c.env.UNSUBSCRIBE_SECRET);
  if (!payload) return c.json({ error: "Invalid or expired link" }, 400);

  await performUnsubscribe(createDb(c.env.DB), payload);
  return c.json({ ok: true });
});
