import { buildRecord, providerGet, withQuery } from "./http";
import type { ImportProvider, MappedStatus, ProviderContext, ProviderPage } from "./types";

// MailerLite API (connect.mailerlite.com, https://developers.mailerlite.com).
// Bearer token. Subscribers belong to the account, so the account is the one
// source. GET /api/subscribers pages by cursor (meta.next_cursor). 120 requests
// a minute; a 429 says "Too Many Attempts".
//
// Each status is read in its own pass (`filter[status]`), because the endpoint's
// unfiltered listing is not documented to include unsubscribed, bounced or junk
// contacts, and an unsubscribe that silently stayed behind would be the one
// thing a migration must never lose. The stored cursor is "<status>:<cursor>".

const BASE = "https://connect.mailerlite.com/api";
const PAGE_SIZE = 100;
const ACCOUNT_SOURCE_ID = "account";
// Only the two statuses Day3 imports are read. Bounced, junk and unconfirmed
// would all be skipped, so fetching them costs requests for nothing.
const PASSES = ["active", "unsubscribed"] as const;

type MlSubscriber = {
  email: string;
  status: string;
  created_at?: string;
  subscribed_at?: string | null;
  unsubscribed_at?: string | null;
  fields?: Record<string, unknown>;
};

type MlListResponse = {
  data: MlSubscriber[];
  meta?: { next_cursor?: string | null };
};

// Subscriber `status`: active, unsubscribed, unconfirmed, bounced, junk.
export function mapMailerLiteStatus(status: string): MappedStatus {
  switch (status) {
    case "active":
      return "subscribed";
    case "unsubscribed":
      return "unsubscribed";
    default:
      return "skip";
  }
}

function headers(ctx: ProviderContext) {
  return { Authorization: `Bearer ${ctx.apiKey}` };
}

function base(ctx: ProviderContext) {
  return ctx.baseUrl ? `${ctx.baseUrl}/api` : BASE;
}

function parseCursor(cursor: string | null): { pass: number; cursor: string | null } {
  if (!cursor) return { pass: 0, cursor: null };
  const idx = cursor.indexOf(":");
  const status = cursor.slice(0, idx);
  const pass = PASSES.indexOf(status as (typeof PASSES)[number]);
  if (pass < 0) return { pass: 0, cursor: null };
  const rest = cursor.slice(idx + 1);
  return { pass, cursor: rest || null };
}

export const mailerliteProvider: ImportProvider = {
  id: "mailerlite",
  mapStatus: mapMailerLiteStatus,

  async listSources(ctx) {
    // `limit=0` returns only the count ("Fetch total subscribers count").
    const res = await providerGet<{ total?: number }>(
      "mailerlite",
      ctx,
      withQuery(`${base(ctx)}/subscribers`, { limit: 0 }),
      headers(ctx),
    );
    return [
      {
        id: ACCOUNT_SOURCE_ID,
        name: "All subscribers",
        subscribedCount: null,
        totalCount: typeof res.total === "number" ? res.total : null,
      },
    ];
  },

  async fetchPage(ctx, _sourceId, stored): Promise<ProviderPage> {
    const { pass, cursor } = parseCursor(stored);
    const status = PASSES[pass];
    const res = await providerGet<MlListResponse>(
      "mailerlite",
      ctx,
      withQuery(`${base(ctx)}/subscribers`, {
        "filter[status]": status,
        limit: PAGE_SIZE,
        cursor,
      }),
      headers(ctx),
    );
    const records = (res.data ?? []).map((s) =>
      buildRecord({
        email: s.email,
        status: mapMailerLiteStatus(s.status),
        fields: s.fields ?? {},
        createdAt: s.subscribed_at || s.created_at,
        unsubscribedAt: s.unsubscribed_at,
      }),
    );
    const next = res.meta?.next_cursor ?? null;
    let nextCursor: string | null = null;
    if (next) nextCursor = `${status}:${next}`;
    else if (pass + 1 < PASSES.length) nextCursor = `${PASSES[pass + 1]}:`;
    return { records, nextCursor, total: null };
  },
};
