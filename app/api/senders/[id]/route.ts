import type { NextRequest } from "next/server";
import { and, eq, ne } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findDomain, findSender } from "@/api/finders";
import { SenderFieldsSchema, validateSenderDomain } from "@/api/senders";
import { senders } from "@/db/schema";
import { nowIso } from "@/lib/ids";

const SenderUpdateSchema = SenderFieldsSchema.extend({
  isDefault: z.boolean().optional(),
});

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req: NextRequest, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const existing = await findSender(db, account.id, id);
  if (!existing) throw new HttpError(404, "Not found");

  const data = await parseJson(req, SenderUpdateSchema);
  const error = await validateSenderDomain(db, account.id, data);
  if (error) throw new HttpError(400, error);

  // Promoting this sender to default demotes the others first, so exactly one
  // default exists per account.
  if (data.isDefault) {
    await db
      .update(senders)
      .set({ isDefault: false, updatedAt: nowIso() })
      .where(and(eq(senders.accountId, account.id), ne(senders.id, id)));
  }

  try {
    await db
      .update(senders)
      .set({
        sendingDomainId: data.sendingDomainId,
        fromName: data.fromName,
        fromEmail: data.fromEmail,
        replyTo: data.replyTo || null,
        ...(data.isDefault === undefined ? {} : { isDefault: data.isDefault }),
        updatedAt: nowIso(),
      })
      .where(eq(senders.id, id));
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
    isDefault: data.isDefault ?? existing.isDefault,
    createdAt: existing.createdAt,
    domain: domain?.domain,
    verificationStatus: domain?.verificationStatus,
    adminOverrideVerified: domain?.adminOverrideVerified,
  };
  return json({ sender });
});

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const existing = await findSender(db, account.id, id);
  if (!existing) throw new HttpError(404, "Not found");

  // Safe to delete regardless of campaigns: campaigns snapshot fromName/fromEmail
  // and reference sender_id only as nullable provenance.
  await db.delete(senders).where(eq(senders.id, id));
  return json({ ok: true });
});
