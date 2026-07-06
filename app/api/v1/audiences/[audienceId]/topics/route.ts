import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { apiRoute, readJson } from "@/api/v1/route";
import { apiJson } from "@/api/v1/errors";
import { requireAudienceV1 } from "@/api/v1/finders";
import { withIdempotency } from "@/api/v1/idempotency";
import { cursorCondition, pageResponse, parsePageQuery } from "@/api/v1/pagination";
import { serializeTopic } from "@/api/v1/serialize";
import { topics } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";

type Params = { params: Promise<{ audienceId: string }> };

// GET /api/v1/audiences/{id}/topics
export const GET = apiRoute<Params>(async (req, { db, account }, { params }) => {
  const { audienceId } = await params;
  const audience = await requireAudienceV1(db, account.id, audienceId);
  const { limit, after } = parsePageQuery(req);

  const filters = [eq(topics.audienceId, audience.id)];
  if (after) filters.push(cursorCondition(topics.createdAt, topics.id, after));

  const rows = await db
    .select()
    .from(topics)
    .where(and(...filters))
    .orderBy(desc(topics.createdAt), desc(topics.id))
    .limit(limit + 1);

  return apiJson(pageResponse(rows, limit, serializeTopic));
});

const CreateTopicSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(300).optional(),
  // true = opt-out model (everyone in unless they leave); false = opt-in.
  // Immutable after creation — flipping it would invert what every stored
  // subscription row means.
  default_subscribed: z.boolean().optional().default(true),
});

// POST /api/v1/audiences/{id}/topics
export const POST = apiRoute<Params>(async (req, ctx, { params }) => {
  const { audienceId } = await params;
  const audience = await requireAudienceV1(ctx.db, ctx.account.id, audienceId);
  const body = await readJson(req, CreateTopicSchema);

  return withIdempotency(ctx, req, `POST /v1/audiences/${audience.id}/topics`, body, async () => {
    const now = nowIso();
    const [created] = await ctx.db
      .insert(topics)
      .values({
        id: newId("top"),
        accountId: ctx.account.id,
        audienceId: audience.id,
        name: body.name,
        description: body.description || null,
        defaultSubscribed: body.default_subscribed,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return apiJson(serializeTopic(created), 201);
  });
});
