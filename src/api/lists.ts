import { desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { apiKeys, audiences, campaigns, forms, sendingDomains } from "../db/schema";
import { resolveFormDesign } from "../lib/form-design";
import { parseScopes } from "./v1/scopes";

// The read side of the list pages, in one place.
//
// Each of these has TWO callers: the server component that renders the page (so
// the rows arrive with the document instead of after a second round trip), and
// the `/api/*` route handler the page's client code re-reads from after a
// mutation. That is the same "two front doors must not diverge" rule the campaign
// send path follows — a list that paginated, filtered, or scoped differently
// depending on whether it was the first paint or a refresh would be a bug nobody
// would think to look for. Add a column here and both doors get it.
//
// Every function takes an explicit accountId and filters on it: the caller has
// already resolved it server-side from the Clerk org (requireAccount), and these
// never see a client-supplied id.

export async function listCampaigns(db: Db, accountId: string) {
  return db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      subject: campaigns.subject,
      status: campaigns.status,
      sandbox: campaigns.sandbox,
      riskLevel: campaigns.riskLevel,
      scheduledAt: campaigns.scheduledAt,
      sentAt: campaigns.sentAt,
      createdAt: campaigns.createdAt,
      // Outer columns are written literally: an interpolated Drizzle column
      // renders UNQUALIFIED in single-table selects, so inside the subquery it
      // resolves against the subquery's own table and the correlation is lost.
      audienceName: sql<string>`(
        SELECT name FROM audiences a WHERE a.id = campaigns.audience_id
      )`.as("audienceName"),
      sentCount: sql<number>`(
        SELECT count(*)::int FROM campaign_recipients r
        WHERE r.campaign_id = campaigns.id AND r.status IN ('sent', 'delivered')
      )`.as("sentCount"),
    })
    .from(campaigns)
    .where(eq(campaigns.accountId, accountId))
    .orderBy(desc(campaigns.createdAt));
}

export async function listAudiences(db: Db, accountId: string) {
  return db
    .select({
      id: audiences.id,
      name: audiences.name,
      createdAt: audiences.createdAt,
      // `audiences.id` is written literally for the same reason as above: an
      // interpolated column would resolve against `s` and lose the correlation.
      subscriberCount: sql<number>`(
        SELECT count(*)::int FROM subscribers s
        WHERE s.audience_id = audiences.id AND s.status = 'subscribed'
      )`.as("subscriberCount"),
    })
    .from(audiences)
    .where(eq(audiences.accountId, accountId))
    .orderBy(desc(audiences.createdAt));
}

export async function listDomains(db: Db, accountId: string) {
  return db
    .select()
    .from(sendingDomains)
    .where(eq(sendingDomains.accountId, accountId))
    .orderBy(desc(sendingDomains.createdAt));
}

// Forms with their audience's name. The names come from one `inArray` lookup
// rather than a per-row subquery: a form list is short, and this keeps it at two
// statements regardless of how many forms the account has.
export async function listForms(db: Db, accountId: string) {
  const rows = await db
    .select()
    .from(forms)
    .where(eq(forms.accountId, accountId))
    .orderBy(desc(forms.createdAt));

  const audienceIds = [...new Set(rows.map((f) => f.audienceId))];
  const audienceRows =
    audienceIds.length > 0
      ? await db.select().from(audiences).where(inArray(audiences.id, audienceIds))
      : [];
  const audienceName = new Map(audienceRows.map((a) => [a.id, a.name]));

  return rows.map((f) => ({
    ...f,
    design: resolveFormDesign(f.design),
    audienceName: audienceName.get(f.audienceId) ?? null,
  }));
}

// Revoked keys are included so the key history stays auditable. The secret itself
// is never stored, so there is nothing here to withhold beyond the prefix.
export function serializeApiKey(k: typeof apiKeys.$inferSelect) {
  return {
    id: k.id,
    name: k.name,
    keyPrefix: k.keyPrefix,
    scopes: parseScopes(k.scopes),
    createdBy: k.createdBy,
    lastUsedAt: k.lastUsedAt,
    revokedAt: k.revokedAt,
    createdAt: k.createdAt,
  };
}

export async function listApiKeys(db: Db, accountId: string) {
  const rows = await db
    .select()
    .from(apiKeys)
    .where(eq(apiKeys.accountId, accountId))
    .orderBy(desc(apiKeys.createdAt));
  return rows.map(serializeApiKey);
}
