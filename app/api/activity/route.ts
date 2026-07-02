import { z } from "zod";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { EMAIL_EVENT_TYPES } from "@/db/schema";
import { listAccountActivity } from "@/services/activity";

const ListActivitySchema = z.object({
  type: z.enum(EMAIL_EVENT_TYPES).optional(),
  campaignId: z.string().optional(),
  search: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

// The Activity log: an account's email events (sends, deliveries, bounces,
// opens, clicks, failures, …) newest-first, filterable for troubleshooting
// ("did jane@example.com get the newsletter, and if not, why?").
export const GET = route(async (req) => {
  const { db, account } = await requireAccount();

  const query = ListActivitySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) throw new HttpError(400, "Invalid query");
  const { type, campaignId, search, limit, offset } = query.data;

  const result = await listAccountActivity(db, account.id, {
    eventType: type,
    campaignId,
    search,
    limit,
    offset,
  });
  return json(result);
});
