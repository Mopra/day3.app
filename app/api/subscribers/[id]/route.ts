import { and, eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { subscribers } from "@/db/schema";

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const subscriber = await db.query.subscribers.findFirst({
    where: and(eq(subscribers.id, id), eq(subscribers.accountId, account.id)),
  });
  if (!subscriber) throw new HttpError(404, "Not found");
  await db.delete(subscribers).where(eq(subscribers.id, subscriber.id));
  return json({ ok: true });
});
