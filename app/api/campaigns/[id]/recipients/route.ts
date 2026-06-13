import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findCampaign } from "@/api/finders";
import { campaignRecipients } from "@/db/schema";

const ListRecipientsSchema = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const GET = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const campaign = await findCampaign(db, account.id, id);
  if (!campaign) throw new HttpError(404, "Not found");

  const query = ListRecipientsSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) throw new HttpError(400, "Invalid query");

  const filters = [eq(campaignRecipients.campaignId, campaign.id)];
  if (query.data.status) {
    filters.push(eq(campaignRecipients.status, query.data.status as never));
  }
  const rows = await db
    .select()
    .from(campaignRecipients)
    .where(and(...filters))
    .orderBy(desc(campaignRecipients.updatedAt))
    .limit(query.data.limit)
    .offset(query.data.offset);
  return json({ recipients: rows });
});
