import { desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import { route, json, parseJson } from "@/api/http";
import { requireAccount } from "@/api/context";
import { audiences } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";

export const GET = route(async () => {
  const { db, account } = await requireAccount();
  const rows = await db
    .select({
      id: audiences.id,
      name: audiences.name,
      createdAt: audiences.createdAt,
      // `audiences.id` is written literally: an interpolated Drizzle column
      // renders UNQUALIFIED in single-table selects, so inside the subquery it
      // resolves against `s` and the correlation is lost.
      subscriberCount: sql<number>`(
        SELECT count(*)::int FROM subscribers s
        WHERE s.audience_id = audiences.id AND s.status = 'subscribed'
      )`.as("subscriberCount"),
    })
    .from(audiences)
    .where(eq(audiences.accountId, account.id))
    .orderBy(desc(audiences.createdAt));
  return json({ audiences: rows });
});

const CreateAudienceSchema = z.object({ name: z.string().trim().min(1).max(100) });

export const POST = route(async (req) => {
  const { db, account } = await requireAccount();
  const { name } = await parseJson(req, CreateAudienceSchema);
  const id = newId("aud");
  const now = nowIso();
  await db.insert(audiences).values({
    id,
    accountId: account.id,
    name,
    createdAt: now,
    updatedAt: now,
  });
  return json({ audience: { id, name } }, 201);
});
