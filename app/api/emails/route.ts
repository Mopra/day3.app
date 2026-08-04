import { and, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { transactionalEmails, type TransactionalEmailStatus } from "@/db/schema";
import { planCanSend } from "@/lib/plans-catalog";

// The /emails page: the account's transactional (API-sent) emails, newest
// first, filterable by status and searchable by recipient/subject. Bodies are
// deliberately not selected — the list stays light; the detail route carries
// them.

const PUBLIC_STATUS_FILTERS: Record<string, TransactionalEmailStatus[]> = {
  queued: ["queued", "sending"],
  sent: ["sent"],
  delivered: ["delivered"],
  bounced: ["bounced"],
  complained: ["complained"],
  failed: ["failed"],
  suppressed: ["suppressed"],
};

const ListEmailsSchema = z.object({
  status: z.enum(Object.keys(PUBLIC_STATUS_FILTERS) as [string, ...string[]]).optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Ceilinged: the search is a leading-wildcard scan, so unbounded offsets let
  // one session walk the tenant's whole history at arbitrary depth. Deep paging
  // isn't a real use case here — filter instead.
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
});

// Escape LIKE metacharacters so a user's `%` or `_` narrows the search the way
// they typed it instead of widening the scan.
function likeTerm(raw: string): string {
  return `%${raw.trim().replace(/[\\%_]/g, "\\$&")}%`;
}

export const GET = route(async (req) => {
  const { db, account } = await requireAccount();

  const query = ListEmailsSchema.safeParse(Object.fromEntries(req.nextUrl.searchParams));
  if (!query.success) throw new HttpError(400, "Invalid query");
  const { status, search, limit, offset } = query.data;

  const filters = [eq(transactionalEmails.accountId, account.id)];
  if (status) filters.push(inArray(transactionalEmails.status, PUBLIC_STATUS_FILTERS[status]));
  if (search) {
    const term = likeTerm(search);
    filters.push(
      or(
        ilike(transactionalEmails.subject, term),
        // `to` is a jsonb string array; its text rendering contains the
        // addresses, which is exactly what a substring search needs.
        sql`${transactionalEmails.to}::text ilike ${term}`,
      )!,
    );
  }
  const where = and(...filters);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)`.as("total") })
    .from(transactionalEmails)
    .where(where);

  const emails = await db
    .select({
      id: transactionalEmails.id,
      fromEmail: transactionalEmails.fromEmail,
      fromName: transactionalEmails.fromName,
      to: transactionalEmails.to,
      subject: transactionalEmails.subject,
      status: transactionalEmails.status,
      error: transactionalEmails.error,
      sandbox: transactionalEmails.sandbox,
      tags: transactionalEmails.tags,
      providerMessageId: transactionalEmails.providerMessageId,
      createdAt: transactionalEmails.createdAt,
      sentAt: transactionalEmails.sentAt,
      deliveredAt: transactionalEmails.deliveredAt,
      bouncedAt: transactionalEmails.bouncedAt,
      complainedAt: transactionalEmails.complainedAt,
    })
    .from(transactionalEmails)
    .where(where)
    .orderBy(desc(transactionalEmails.createdAt), desc(transactionalEmails.id))
    .limit(limit)
    .offset(offset);

  // `sandbox` tells the page whether sends run under the free-tier carve-out
  // (org members only, small allowance) so it can show the banner.
  return json({ emails, total: Number(total), sandbox: !planCanSend(account.plan) });
});
