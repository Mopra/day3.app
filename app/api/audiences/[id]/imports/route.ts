import { desc, eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { imports } from "@/db/schema";

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");
  const rows = await db
    .select()
    .from(imports)
    .where(eq(imports.audienceId, audience.id))
    .orderBy(desc(imports.createdAt))
    .limit(10);
  return json({ imports: rows });
});
