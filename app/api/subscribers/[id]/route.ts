import { eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findSubscriber } from "@/api/finders";
import { subscribers } from "@/db/schema";
import { nowIso } from "@/lib/ids";

// Editing the contact's details. Status is deliberately not editable here —
// status transitions (unsubscribe, resubscribe) flow through their own routes so
// suppression and double opt-in rules stay enforced.
const UpdateSubscriberSchema = z.object({
  email: z.email().trim().toLowerCase().optional(),
  firstName: z.string().trim().max(100).optional().or(z.literal("")),
  lastName: z.string().trim().max(100).optional().or(z.literal("")),
});

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const subscriber = await findSubscriber(db, account.id, id);
  if (!subscriber) throw new HttpError(404, "Not found");

  const data = await parseJson(req, UpdateSubscriberSchema);
  const set: Partial<typeof subscribers.$inferInsert> = { updatedAt: nowIso() };
  if (data.email !== undefined) set.email = data.email;
  if (data.firstName !== undefined) set.firstName = data.firstName || null;
  if (data.lastName !== undefined) set.lastName = data.lastName || null;

  try {
    await db.update(subscribers).set(set).where(eq(subscribers.id, subscriber.id));
  } catch {
    // Unique (audience_id, email) — the new address is already in this audience.
    throw new HttpError(409, "That email is already in this audience");
  }

  const updated = await findSubscriber(db, account.id, subscriber.id);
  return json({ subscriber: updated });
});

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const subscriber = await findSubscriber(db, account.id, id);
  if (!subscriber) throw new HttpError(404, "Not found");
  await db.delete(subscribers).where(eq(subscribers.id, subscriber.id));
  return json({ ok: true });
});
