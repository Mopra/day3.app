import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { apiJson } from "@/api/v1/errors";
import { withIdempotency } from "@/api/v1/idempotency";
import { cursorCondition, pageResponse, parsePageQuery } from "@/api/v1/pagination";
import { serializeAudience } from "@/api/v1/serialize";
import { audiences } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";

// GET /api/v1/audiences — cursor-paginated list.
export const GET = apiRoute(async (req, { db, account }) => {
  const { limit, after } = parsePageQuery(req);
  const filters = [eq(audiences.accountId, account.id)];
  if (after) filters.push(cursorCondition(audiences.createdAt, audiences.id, after));

  const rows = await db
    .select()
    .from(audiences)
    .where(and(...filters))
    .orderBy(desc(audiences.createdAt), desc(audiences.id))
    .limit(limit + 1);

  return apiJson(pageResponse(rows, limit, (a) => serializeAudience(a)));
});

const CreateAudienceSchema = z.object({ name: z.string().trim().min(1).max(100) });

// POST /api/v1/audiences — create.
export const POST = apiRoute(async (req, ctx) => {
  const body = await readJson(req, CreateAudienceSchema);
  return withIdempotency(ctx, req, "POST /v1/audiences", body, async () => {
    const now = nowIso();
    const [created] = await ctx.db
      .insert(audiences)
      .values({
        id: newId("aud"),
        accountId: ctx.account.id,
        name: body.name,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return apiJson(serializeAudience(created), 201);
  });
});
