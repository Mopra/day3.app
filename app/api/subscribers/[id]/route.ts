import { eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findSubscriber } from "@/api/finders";
import { subscribers } from "@/db/schema";

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const subscriber = await findSubscriber(db, account.id, id);
  if (!subscriber) throw new HttpError(404, "Not found");
  await db.delete(subscribers).where(eq(subscribers.id, subscriber.id));
  return json({ ok: true });
});
