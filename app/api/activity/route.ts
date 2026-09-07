import { z } from "zod";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { planCanSend } from "@/lib/plans-catalog";
import { ACTIVITY_SOURCES, ACTIVITY_STATUSES, listAccountActivity } from "@/services/activity";

const ListActivitySchema = z.object({
  source: z.enum(ACTIVITY_SOURCES).optional(),
  status: z.enum(ACTIVITY_STATUSES).optional(),
  campaignId: z.string().optional(),
  automationId: z.string().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Ceilinged: the search is a leading-wildcard scan, so unbounded offsets let
  // one session walk the tenant's whole history at arbitrary depth. Deep paging
  // isn't a real use case here — filter instead.
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

// The Activity page: every email the account sent — campaign, automation and
// API sends as one list newest-first — filterable for troubleshooting ("did
// jane@example.com get the newsletter, and if not, why?").
export const GET = route(async (req) => {
  const { db, account } = await requireAccount();

  const query = ListActivitySchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) throw new HttpError(400, "Invalid query");

  const result = await listAccountActivity(db, account.id, query.data);
  // `sandbox` tells the page whether API sends run under the free-tier
  // carve-out (org members only, small allowance) so it can show the banner.
  return json({ ...result, sandbox: !planCanSend(account.plan) });
});
