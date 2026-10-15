import { and, asc, desc, eq, getTableColumns, sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client";
import { imports, segments, subscribers, topics } from "../db/schema";
import { safeParseSegmentFilter, segmentFilterCondition } from "../lib/segment-filter";
import { listAudienceFields } from "../services/audience-fields";

// The reads behind the audience page. Each has two front doors: the server page
// (first paint) and its `/api/audiences/[id]/*` route (the re-read after a
// mutation and the import poll), so both go through these.

export async function audienceStatusCounts(db: Db, audienceId: string) {
  const rows = await db
    .select({ status: subscribers.status, count: sql<number>`count(*)`.as("count") })
    .from(subscribers)
    .where(eq(subscribers.audienceId, audienceId))
    .groupBy(subscribers.status);
  return Object.fromEntries(rows.map((r) => [r.status, Number(r.count)])) as Record<
    string,
    number
  >;
}

// Every import column except the provider key and the paging cursor: this list
// is sent to the browser, and the encrypted key must never leave the server.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const { sourceCredential, sourceCursor, r2Key, ...IMPORT_PUBLIC_COLUMNS } = getTableColumns(imports);

export function listAudienceImports(db: Db, audienceId: string) {
  return db
    .select(IMPORT_PUBLIC_COLUMNS)
    .from(imports)
    .where(eq(imports.audienceId, audienceId))
    .orderBy(desc(imports.createdAt))
    .limit(10);
}

export async function listAudienceFieldRows(db: Db, accountId: string, audienceId: string) {
  const fields = await listAudienceFields(db, accountId, audienceId);
  return fields.map((f) => ({
    id: f.id,
    key: f.key,
    label: f.label,
    type: f.type,
    fallback: f.fallback,
    createdAt: f.createdAt,
  }));
}

// Live membership count: subscribed contacts matching the filter, the number a
// campaign sent to this segment would target (before suppression).
export async function segmentCount(
  db: Db,
  audienceId: string,
  filterJson: string,
): Promise<number | null> {
  const filter = safeParseSegmentFilter(filterJson);
  if (!filter) return null;
  const [{ count }] = await db
    .select({ count: sql<number>`count(*)`.as("count") })
    .from(subscribers)
    .where(
      and(
        eq(subscribers.audienceId, audienceId),
        eq(subscribers.status, "subscribed"),
        segmentFilterCondition(filter),
      ),
    );
  return Number(count);
}

export async function listSegmentRows(db: Db, accountId: string, audienceId: string) {
  const rows = await db
    .select()
    .from(segments)
    .where(and(eq(segments.accountId, accountId), eq(segments.audienceId, audienceId)))
    .orderBy(asc(segments.createdAt));
  return Promise.all(
    rows.map(async (s) => ({
      id: s.id,
      name: s.name,
      filter: safeParseSegmentFilter(s.filterJson),
      count: await segmentCount(db, audienceId, s.filterJson),
      createdAt: s.createdAt,
    })),
  );
}

export async function listTopicRows(db: Db, accountId: string, audienceId: string) {
  const rows = await db
    .select({
      id: topics.id,
      name: topics.name,
      description: topics.description,
      defaultSubscribed: topics.defaultSubscribed,
      createdAt: topics.createdAt,
      // Outer column written literally in the raw subquery: an interpolated
      // Drizzle column renders unqualified there and would lose the correlation.
      optedOut: sql<number>`(
        select count(*)::int from topic_subscriptions ts
        where ts.topic_id = topics.id and ts.subscribed = false
      )`.as("optedOut"),
      optedIn: sql<number>`(
        select count(*)::int from topic_subscriptions ts
        where ts.topic_id = topics.id and ts.subscribed = true
      )`.as("optedIn"),
    })
    .from(topics)
    .where(and(eq(topics.accountId, accountId), eq(topics.audienceId, audienceId)))
    .orderBy(asc(topics.createdAt));
  return rows.map((t) => ({ ...t, optedOut: Number(t.optedOut), optedIn: Number(t.optedIn) }));
}

// One page of contacts, newest first, plus the total matching `filters`.
export async function listSubscriberPage(
  db: Db,
  audienceId: string,
  filters: SQL[],
  limit: number,
  offset: number,
) {
  const where = and(eq(subscribers.audienceId, audienceId), ...filters);
  const [rows, [{ total }]] = await Promise.all([
    db
      .select()
      .from(subscribers)
      .where(where)
      .orderBy(desc(subscribers.createdAt))
      .limit(limit)
      .offset(offset),
    db
      .select({ total: sql<number>`count(*)`.as("total") })
      .from(subscribers)
      .where(where),
  ]);
  return { subscribers: rows, total: Number(total) };
}
