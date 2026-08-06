import { and, desc, eq } from "drizzle-orm";
import { apiRoute, readJson } from "@/api/v1/route";
import { apiJson } from "@/api/v1/errors";
import { CampaignInputSchema, createCampaign, serializeCampaign } from "@/api/v1/campaigns";
import { withIdempotency } from "@/api/v1/idempotency";
import { cursorCondition, pageResponse, parsePageQuery } from "@/api/v1/pagination";
import { campaigns } from "@/db/schema";

// GET /api/v1/campaigns — cursor-paginated list, newest first. Bodies are
// omitted (rendering markdown for 100 rows is wasted work); fetch a single
// campaign to get its content.
export const GET = apiRoute(async (req, { db, account }) => {
  const { limit, after } = parsePageQuery(req);
  const filters = [eq(campaigns.accountId, account.id)];
  const status = req.nextUrl.searchParams.get("status");
  if (status) filters.push(eq(campaigns.status, status as never));
  if (after) filters.push(cursorCondition(campaigns.createdAt, campaigns.id, after));

  const rows = await db
    .select()
    .from(campaigns)
    .where(and(...filters))
    .orderBy(desc(campaigns.createdAt), desc(campaigns.id))
    .limit(limit + 1);

  return apiJson(pageResponse(rows, limit, (c) => serializeCampaign(c)));
});

// POST /api/v1/campaigns — create a draft.
export const POST = apiRoute(async (req, ctx) => {
  const body = await readJson(req, CampaignInputSchema);
  return withIdempotency(ctx, req, "POST /v1/campaigns", body, async () => {
    const created = await createCampaign(ctx.db, ctx.account.id, body);
    return apiJson(serializeCampaign(created, { body: true }), 201);
  });
});
