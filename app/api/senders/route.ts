import type { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findDomain } from "@/api/finders";
import { SenderFieldsSchema, validateSenderDomain, listSendersWithDomain } from "@/api/senders";
import { senders } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";

export const GET = route(async () => {
  const { db, account } = await requireAccount();
  const rows = await listSendersWithDomain(db, account.id);
  return json({ senders: rows });
});

export const POST = route(async (req: NextRequest) => {
  const { db, account } = await requireAccount();
  const data = await parseJson(req, SenderFieldsSchema);

  const error = await validateSenderDomain(db, account.id, data);
  if (error) throw new HttpError(400, error);

  // The account's first sender becomes its default (so the composer preselects it).
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(senders)
    .where(eq(senders.accountId, account.id));
  const isDefault = Number(count) === 0;

  const id = newId("snd");
  const now = nowIso();
  try {
    await db.insert(senders).values({
      id,
      accountId: account.id,
      sendingDomainId: data.sendingDomainId,
      fromName: data.fromName,
      fromEmail: data.fromEmail,
      replyTo: data.replyTo || null,
      isDefault,
      createdAt: now,
      updatedAt: now,
    });
  } catch {
    throw new HttpError(409, "A sender with that email already exists");
  }

  const domain = await findDomain(db, account.id, data.sendingDomainId);
  const sender = {
    id,
    sendingDomainId: data.sendingDomainId,
    fromName: data.fromName,
    fromEmail: data.fromEmail,
    replyTo: data.replyTo || null,
    isDefault,
    createdAt: now,
    domain: domain?.domain,
    verificationStatus: domain?.verificationStatus,
    adminOverrideVerified: domain?.adminOverrideVerified,
  };
  return json({ sender }, 201);
});
