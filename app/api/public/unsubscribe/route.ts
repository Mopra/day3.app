import type { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { getDb } from "@/db/client";
import type { Db } from "@/db/client";
import { accounts, campaigns, emailEvents, subscribers, topics } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { verifyUnsubscribeToken, type UnsubscribeTokenPayload } from "@/services/unsubscribe";
import { applyUnsubscribe } from "@/services/unsubscribe-action";
import { setTopicSubscription } from "@/services/topic-subscription";
import { requireUnsubscribeSecret } from "@/lib/env";
import { enforceRateLimit, clientIp } from "@/lib/rate-limit";

// When the campaign behind this link was sent under a topic and the recipient is
// a real subscriber, the page can offer "just stop this topic" alongside the
// full unsubscribe. Null otherwise (no topic, deleted topic, or a test send
// with no subscriber row).
async function topicChoiceFor(
  db: Db,
  payload: UnsubscribeTokenPayload,
): Promise<{ id: string; name: string } | null> {
  if (!payload.campaignId || !payload.subscriberId) return null;
  const campaign = await db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, payload.campaignId), eq(campaigns.accountId, payload.accountId)),
  });
  if (!campaign?.topicId) return null;
  const topic = await db.query.topics.findFirst({
    where: and(eq(topics.id, campaign.topicId), eq(topics.accountId, payload.accountId)),
  });
  if (!topic) return null;
  const subscriber = await db.query.subscribers.findFirst({
    where: and(
      eq(subscribers.id, payload.subscriberId),
      eq(subscribers.accountId, payload.accountId),
    ),
  });
  if (!subscriber) return null;
  return { id: topic.id, name: topic.name };
}

export const GET = route(async (req: NextRequest) => {
  await enforceRateLimit("unsubscribe", clientIp(req));
  const token = req.nextUrl.searchParams.get("token") ?? "";
  const payload = await verifyUnsubscribeToken(token, requireUnsubscribeSecret());
  if (!payload) throw new HttpError(400, "Invalid or expired link");

  const db = getDb();
  const account = await db.query.accounts.findFirst({
    where: eq(accounts.id, payload.accountId),
  });
  return json({
    email: payload.email,
    companyName: account?.name ?? "this sender",
    topic: await topicChoiceFor(db, payload),
  });
});

const ConfirmSchema = z.object({
  token: z.string().min(1),
  // "all" (default) = the classic full unsubscribe; "topic" = only opt out of
  // the topic the campaign was sent under (keeps receiving everything else).
  scope: z.enum(["all", "topic"]).optional(),
});

export const POST = route(async (req: NextRequest) => {
  await enforceRateLimit("unsubscribe", clientIp(req));
  // Support both the SPA JSON body and the form-encoded one-click
  // List-Unsubscribe-Post (RFC 8058) flow, which posts to the token URL.
  // One-click is always a FULL unsubscribe — mail clients offer no choice UI.
  let token = req.nextUrl.searchParams.get("token") ?? "";
  let scope: "all" | "topic" = "all";
  if (!token) {
    const contentType = req.headers.get("content-type") ?? "";
    if (contentType.includes("application/json")) {
      const body = await parseJson(req, ConfirmSchema);
      token = body.token;
      scope = body.scope ?? "all";
    }
  }

  const payload = await verifyUnsubscribeToken(token, requireUnsubscribeSecret());
  if (!payload) throw new HttpError(400, "Invalid or expired link");

  const db = getDb();
  if (scope === "topic") {
    const topic = await topicChoiceFor(db, payload);
    // No topic to opt out of (deleted meanwhile, or a test send) — never fall
    // back to a silent full unsubscribe; tell the page to re-render instead.
    if (!topic) throw new HttpError(409, "This email has no topic to opt out of");
    await setTopicSubscription(db, {
      accountId: payload.accountId,
      topicId: topic.id,
      subscriberId: payload.subscriberId,
      subscribed: false,
    });
    // Audit trail alongside the full-unsubscribe events, distinguishable via
    // the payload (no suppression, no status change happened).
    await db.insert(emailEvents).values({
      id: newId("evt"),
      accountId: payload.accountId,
      campaignId: payload.campaignId ?? null,
      campaignRecipientId: payload.campaignRecipientId ?? null,
      eventType: "unsubscribe",
      email: payload.email,
      provider: "ses",
      payloadJson: JSON.stringify({ scope: "topic", topicId: topic.id, topicName: topic.name }),
      createdAt: nowIso(),
    });
    return json({ ok: true, scope: "topic", topicName: topic.name });
  }

  await applyUnsubscribe(db, payload);
  return json({ ok: true, scope: "all" });
});
