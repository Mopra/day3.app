import { z } from "zod";
import { route, json, parseJson } from "@/api/http";
import { requireAccount } from "@/api/context";
import { listAudiences } from "@/api/lists";
import { audiences } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";

export const GET = route(async () => {
  const { db, account } = await requireAccount();
  return json({ audiences: await listAudiences(db, account.id) });
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
