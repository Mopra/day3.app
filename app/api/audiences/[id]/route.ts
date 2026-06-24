import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { audiences, subscribers } from "@/db/schema";
import { nowIso } from "@/lib/ids";

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const counts = await db
    .select({ status: subscribers.status, count: sql<number>`count(*)`.as("count") })
    .from(subscribers)
    .where(eq(subscribers.audienceId, audience.id))
    .groupBy(subscribers.status);

  return json({
    audience,
    counts: Object.fromEntries(counts.map((r) => [r.status, Number(r.count)])),
  });
});

const UpdateAudienceSchema = z.object({ name: z.string().trim().min(1).max(100) });

export const PATCH = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const { name } = await parseJson(req, UpdateAudienceSchema);
  await db
    .update(audiences)
    .set({ name, updatedAt: nowIso() })
    .where(eq(audiences.id, audience.id));
  return json({ audience: { id: audience.id, name } });
});

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");
  await db.delete(subscribers).where(eq(subscribers.audienceId, audience.id));
  await db.delete(audiences).where(eq(audiences.id, audience.id));
  return json({ ok: true });
});
