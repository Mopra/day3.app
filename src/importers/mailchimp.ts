import { buildRecord, providerError, providerGet, withQuery } from "./http";
import type { ImportProvider, MappedStatus, ProviderContext, ProviderPage } from "./types";

// Mailchimp Marketing API 3.0 (OpenAPI: github.com/mailchimp/
// mailchimp-client-lib-codegen spec/marketing.json). The key ends in its data
// center (`...-us21`), which picks the host `us21.api.mailchimp.com`. Basic auth
// with any user name. Each audience (a "list") is one source. Members page by
// `offset` / `count` (max 1000) against `total_items`; the cursor we store is the
// next offset.

const PAGE_SIZE = 1000;

type McList = {
  id: string;
  name: string;
  stats?: { member_count?: number; unsubscribe_count?: number; cleaned_count?: number };
};

type McMember = {
  email_address: string;
  status: string;
  merge_fields?: Record<string, unknown>;
  timestamp_signup?: string;
  timestamp_opt?: string;
  last_changed?: string;
};

// The data center is the key's suffix. Validated strictly because it becomes
// part of a host name we connect to: anything else is a bad key, never a URL.
export function mailchimpDataCenter(apiKey: string): string | null {
  const m = /-([a-z]{2,4}\d{1,3})$/.exec(apiKey.trim());
  return m ? m[1] : null;
}

// Member `status` enum:
//   subscribed   → subscribed
//   unsubscribed → unsubscribed
//   cleaned (hard bounced), pending (double opt-in not done),
//   transactional (never opted in to marketing), archived → skipped
export function mapMailchimpStatus(status: string): MappedStatus {
  switch (status) {
    case "subscribed":
      return "subscribed";
    case "unsubscribed":
      return "unsubscribed";
    default:
      return "skip";
  }
}

function base(ctx: ProviderContext): string {
  if (ctx.baseUrl) return `${ctx.baseUrl}/3.0`;
  const dc = mailchimpDataCenter(ctx.apiKey);
  if (!dc) throw providerError("mailchimp", "bad_key");
  return `https://${dc}.api.mailchimp.com/3.0`;
}

function headers(ctx: ProviderContext) {
  return { Authorization: `Basic ${Buffer.from(`day3:${ctx.apiKey}`).toString("base64")}` };
}

// Merge tags that are a name, the rest become custom fields. ADDRESS is an
// object in Mailchimp; flatten it to one line.
function mergeFields(m: Record<string, unknown> | undefined) {
  const fields: Record<string, unknown> = {};
  let firstName: unknown;
  let lastName: unknown;
  for (const [tag, value] of Object.entries(m ?? {})) {
    if (tag === "FNAME") firstName = value;
    else if (tag === "LNAME") lastName = value;
    else if (value && typeof value === "object" && !Array.isArray(value)) {
      fields[tag] = Object.values(value as Record<string, unknown>)
        .filter((v) => v !== null && v !== undefined && String(v).trim() !== "")
        .join(", ");
    } else fields[tag] = value;
  }
  return { firstName, lastName, fields };
}

export const mailchimpProvider: ImportProvider = {
  id: "mailchimp",
  mapStatus: mapMailchimpStatus,

  async listSources(ctx) {
    const res = await providerGet<{ lists: McList[] }>(
      "mailchimp",
      ctx,
      withQuery(`${base(ctx)}/lists`, {
        count: 1000,
        fields: "lists.id,lists.name,lists.stats.member_count,lists.stats.unsubscribe_count,lists.stats.cleaned_count",
      }),
      headers(ctx),
    );
    return (res.lists ?? []).map((l) => {
      const subscribed = l.stats?.member_count ?? null;
      const total =
        subscribed === null
          ? null
          : subscribed + (l.stats?.unsubscribe_count ?? 0) + (l.stats?.cleaned_count ?? 0);
      return { id: l.id, name: l.name, subscribedCount: subscribed, totalCount: total };
    });
  },

  async fetchPage(ctx, sourceId, cursor): Promise<ProviderPage> {
    const offset = cursor ? Number(cursor) : 0;
    if (!Number.isInteger(offset) || offset < 0) throw new Error(`Bad Mailchimp offset ${cursor}`);
    const res = await providerGet<{ members: McMember[]; total_items?: number }>(
      "mailchimp",
      ctx,
      withQuery(`${base(ctx)}/lists/${encodeURIComponent(sourceId)}/members`, {
        count: PAGE_SIZE,
        offset,
        fields:
          "members.email_address,members.status,members.merge_fields,members.timestamp_signup,members.timestamp_opt,members.last_changed,total_items",
      }),
      headers(ctx),
    );
    const members = res.members ?? [];
    const records = members.map((m) => {
      const { firstName, lastName, fields } = mergeFields(m.merge_fields);
      return buildRecord({
        email: m.email_address,
        status: mapMailchimpStatus(m.status),
        firstName,
        lastName,
        fields,
        createdAt: m.timestamp_signup || m.timestamp_opt || undefined,
        // Mailchimp does not expose the opt-out time on the member; last_changed
        // is the closest honest date.
        unsubscribedAt: m.last_changed,
      });
    });
    const next = offset + members.length;
    const total = res.total_items ?? null;
    const nextCursor =
      members.length > 0 && (total === null ? members.length === PAGE_SIZE : next < total)
        ? String(next)
        : null;
    return { records, nextCursor, total };
  },
};
