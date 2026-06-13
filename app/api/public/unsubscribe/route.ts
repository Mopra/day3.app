import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { getDb, type Db } from "@/db/client";
import { accounts, campaignRecipients, emailEvents, subscribers } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { verifyUnsubscribeToken } from "@/services/unsubscribe";
import { addSuppression } from "@/services/suppression";

export const GET = route(async (req: NextRequest) => {
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const payload = await verifyUnsubscribeToken(token, process.env.UNSUBSCRIBE_SECRET ?? "");
  if (!payload) throw new HttpError(400, "Invalid or expired link");

  const db = getDb();
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, payload.accountId),
  });
  return json({ email: payload.email, companyName: account?.name ?? "this sender" });
});

const ConfirmSchema = z.object({ token: z.string().min(1) });

async function performUnsubscribe(
  db: Db,
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
    provider: "ses",
    createdAt: now,
  });
}

export const POST = route(async (req: NextRequest) => {
  // Support both the SPA JSON body and the form-encoded one-click
  // List-Unsubscribe-Post (RFC 8058) flow, which posts to the token URL.
  let token = req.nextUrl.searchParams.get("token") ?? "";
  if (!token) {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      token = (await parseJson(req, ConfirmSchema)).token;
    }
  }

  const payload = await verifyUnsubscribeToken(token, process.env.UNSUBSCRIBE_SECRET ?? "");
  if (!payload) throw new HttpError(400, "Invalid or expired link");

  await performUnsubscribe(getDb(), payload);
  return json({ ok: true });
});
