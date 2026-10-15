import { buildRecord, providerGet, withQuery } from "./http";
import type { ImportProvider, MappedStatus, ProviderContext, ProviderPage } from "./types";

// Kit (ConvertKit) API v4 (https://developers.kit.com, OpenAPI at
// /api-reference/v4.json). `X-Kit-Api-Key` header. Subscribers belong to the
// account, not to a list, so the account is the one importable source.
// GET /v4/subscribers pages by cursor (`after` = pagination.end_cursor while
// has_next_page), up to 1000 per page, and returns only `active` unless
// `status=all` is asked for.

const BASE = "https://api.kit.com";
const PAGE_SIZE = 1000;
const ACCOUNT_SOURCE_ID = "account";

type KitSubscriber = {
  id: number;
  first_name: string | null;
  email_address: string;
  state: string;
  created_at?: string;
  fields?: Record<string, unknown>;
};

type KitSubscribersResponse = {
  subscribers: KitSubscriber[];
  pagination?: { has_next_page?: boolean; end_cursor?: string | null };
  total_count?: number;
};

type KitAccountResponse = { account?: { id?: number; name?: string } };

// Kit subscriber states (the `state` enum on /v4/subscribers):
//   active     → subscribed
//   cancelled  → unsubscribed (Kit's word for an opt-out)
//   bounced / complained → skipped (belongs on the suppression list)
//   inactive   → skipped (never confirmed the double opt-in)
export function mapKitStatus(state: string): MappedStatus {
  switch (state) {
    case "active":
      return "subscribed";
    case "cancelled":
      return "unsubscribed";
    default:
      return "skip";
  }
}

function headers(ctx: ProviderContext) {
  return { "X-Kit-Api-Key": ctx.apiKey };
}

function base(ctx: ProviderContext) {
  return ctx.baseUrl ?? BASE;
}

export const kitProvider: ImportProvider = {
  id: "kit",
  mapStatus: mapKitStatus,

  async listSources(ctx) {
    const account = await providerGet<KitAccountResponse>(
      "kit",
      ctx,
      `${base(ctx)}/v4/account`,
      headers(ctx),
    );
    // One cheap call for the active count, so the free-plan cap can be checked
    // before the job starts.
    const active = await providerGet<KitSubscribersResponse>(
      "kit",
      ctx,
      withQuery(`${base(ctx)}/v4/subscribers`, {
        status: "active",
        per_page: 1,
        include_total_count: "true",
        slim: "true",
      }),
      headers(ctx),
    );
    return [
      {
        id: ACCOUNT_SOURCE_ID,
        name: account.account?.name ? `${account.account.name} (all subscribers)` : "All subscribers",
        subscribedCount: active.total_count ?? null,
        totalCount: null,
      },
    ];
  },

  async fetchPage(ctx, _sourceId, cursor): Promise<ProviderPage> {
    const res = await providerGet<KitSubscribersResponse>(
      "kit",
      ctx,
      withQuery(`${base(ctx)}/v4/subscribers`, {
        status: "all",
        per_page: PAGE_SIZE,
        after: cursor,
        // Asked once; Kit warns it is slow to compute on every page.
        include_total_count: cursor ? undefined : "true",
      }),
      headers(ctx),
    );
    const records = (res.subscribers ?? []).map((s) =>
      buildRecord({
        email: s.email_address,
        status: mapKitStatus(s.state),
        firstName: s.first_name,
        fields: s.fields ?? {},
        createdAt: s.created_at,
      }),
    );
    const nextCursor =
      res.pagination?.has_next_page && res.pagination.end_cursor ? res.pagination.end_cursor : null;
    return { records, nextCursor, total: res.total_count ?? null };
  },
};
