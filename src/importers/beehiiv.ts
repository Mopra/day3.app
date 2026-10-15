import { buildRecord, providerGet, withQuery } from "./http";
import type { ImportProvider, MappedStatus, ProviderContext, ProviderPage } from "./types";

// beehiiv API v2 (https://developers.beehiiv.com, OpenAPI at
// /openapi/api-reference.json). Bearer key; one importable source per
// publication. Subscriptions page by cursor (`next_cursor` / `has_more`, the
// offset `page` parameter is deprecated and capped at 100 pages), 100 per page.
// Rate limits are per key per minute (30 on Free up to 800 on Enterprise) and a
// 429 carries RateLimit-Reset as an epoch second.

const BASE = "https://api.beehiiv.com/v2";
const PAGE_SIZE = 100;

type BeehiivPublication = {
  id: string;
  name: string;
  stats?: { active_subscriptions?: number | boolean };
};

type BeehiivSubscription = {
  id: string;
  email: string;
  status: string;
  created?: number;
  custom_fields?: Array<{ name: string; kind?: string; value: unknown }>;
};

type BeehiivList<T> = {
  data: T[];
  page?: number;
  total_pages?: number;
  total_results?: number;
  has_more?: boolean;
  next_cursor?: string | null;
};

// SubscriptionExpandedStatus, in the spec's words:
//   active          - the subscription is active                 → subscribed
//   inactive        - made inactive, possibly due to an unsubscribe → unsubscribed
//   paused          - the subscriber paused their subscription   → unsubscribed
//                     (they asked not to be mailed for now; Day3 has no pause,
//                     and mailing them would break that promise)
//   validating / invalid / pending (double opt-in not done) /
//   needs_attention (awaiting approval)                          → skipped
export function mapBeehiivStatus(status: string): MappedStatus {
  switch (status) {
    case "active":
      return "subscribed";
    case "inactive":
    case "paused":
      return "unsubscribed";
    default:
      return "skip";
  }
}

function headers(ctx: ProviderContext) {
  return { Authorization: `Bearer ${ctx.apiKey}` };
}

function base(ctx: ProviderContext) {
  return ctx.baseUrl ? `${ctx.baseUrl}/v2` : BASE;
}

function count(v: number | boolean | undefined): number | null {
  return typeof v === "number" ? v : null;
}

export const beehiivProvider: ImportProvider = {
  id: "beehiiv",
  mapStatus: mapBeehiivStatus,

  async listSources(ctx) {
    const out = [];
    for (let page = 1; page <= 20; page++) {
      const res = await providerGet<BeehiivList<BeehiivPublication>>(
        "beehiiv",
        ctx,
        withQuery(`${base(ctx)}/publications`, {
          limit: PAGE_SIZE,
          page,
          "expand[]": "stat_active_subscriptions",
        }),
        headers(ctx),
      );
      for (const p of res.data ?? []) {
        out.push({
          id: p.id,
          name: p.name,
          subscribedCount: count(p.stats?.active_subscriptions),
          totalCount: null,
        });
      }
      if (!res.total_pages || page >= res.total_pages) break;
    }
    return out;
  },

  async fetchPage(ctx, sourceId, cursor): Promise<ProviderPage> {
    const res = await providerGet<BeehiivList<BeehiivSubscription>>(
      "beehiiv",
      ctx,
      withQuery(`${base(ctx)}/publications/${encodeURIComponent(sourceId)}/subscriptions`, {
        limit: PAGE_SIZE,
        status: "all",
        "expand[]": "custom_fields",
        cursor,
      }),
      headers(ctx),
    );
    // beehiiv marks an address it found undeliverable `invalid`: count it with
    // the malformed addresses rather than as a status skip.
    const records = (res.data ?? []).map((s) =>
      s.status === "invalid"
        ? ({ kind: "skip", reason: "invalid" } as const)
        : buildRecord({
            email: s.email,
            status: mapBeehiivStatus(s.status),
            fields: s.custom_fields ?? [],
            createdAt: s.created,
          }),
    );
    const nextCursor = res.has_more && res.next_cursor ? res.next_cursor : null;
    return { records, nextCursor, total: res.total_results ?? null };
  },
};
