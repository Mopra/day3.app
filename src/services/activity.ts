import { and, desc, eq, like, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { campaigns, emailEvents, type EmailEventType } from "../db/schema";
import type { ActivityEvent } from "../lib/types";

export type ActivityFilters = {
  eventType?: EmailEventType;
  campaignId?: string;
  /** Substring match against the recipient email (case-insensitive). */
  search?: string;
  limit: number;
  offset: number;
};

// The account-wide Activity log: every email event (send, delivery, bounce,
// complaint, open, click, unsubscribe, failure) newest-first, with the campaign
// name joined in. Account-scoped (hard rule); `total` counts the filtered set
// so the page can show "n of m" and page with offsets.
export async function listAccountActivity(
  db: Db,
  accountId: string,
  filters: ActivityFilters,
): Promise<{ events: ActivityEvent[]; total: number }> {
  const conditions: SQL[] = [eq(emailEvents.accountId, accountId)];
  if (filters.eventType) conditions.push(eq(emailEvents.eventType, filters.eventType));
  if (filters.campaignId) conditions.push(eq(emailEvents.campaignId, filters.campaignId));
  if (filters.search) {
    // Emails are stored lowercase; same substring idiom as the subscribers list.
    conditions.push(like(emailEvents.email, `%${filters.search.toLowerCase()}%`));
  }
  const where = and(...conditions);

  const rows = await db
    .select({
      id: emailEvents.id,
      eventType: emailEvents.eventType,
      email: emailEvents.email,
      campaignId: emailEvents.campaignId,
      campaignName: campaigns.name,
      provider: emailEvents.provider,
      providerMessageId: emailEvents.providerMessageId,
      payloadJson: emailEvents.payloadJson,
      createdAt: emailEvents.createdAt,
    })
    .from(emailEvents)
    .leftJoin(campaigns, eq(campaigns.id, emailEvents.campaignId))
    .where(where)
    // id tie-breaks equal timestamps (batch inserts share one) so offset
    // pagination never skips or repeats a row.
    .orderBy(desc(emailEvents.createdAt), desc(emailEvents.id))
    .limit(filters.limit)
    .offset(filters.offset);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)`.as("total") })
    .from(emailEvents)
    .where(where);

  return { events: rows, total: Number(total) };
}
