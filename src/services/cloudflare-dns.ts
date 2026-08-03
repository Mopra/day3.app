// Cloudflare DNS client: looks up a customer's zone and writes the SES
// verification records (DKIM CNAMEs, DMARC TXT) into it on their behalf, using a
// token obtained via the Cloudflare OAuth connect flow.
//
// These functions are deliberately pure — they take a bearer token and use global
// fetch, with no DB or env coupling — so the idempotency logic is unit-testable
// against a mocked Cloudflare API. Token storage/refresh persistence lives in the
// route layer.
import type { DnsRecord } from "../lib/types";
import { registrableRoot } from "../lib/domain";

const CF_API = "https://api.cloudflare.com/client/v4";

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public errors?: { code: number; message: string }[],
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

type CfEnvelope<T> = {
  success: boolean;
  errors: { code: number; message: string }[];
  result: T;
};

async function cfFetch<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${CF_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  const body = (await res.json().catch(() => null)) as CfEnvelope<T> | null;
  if (!res.ok || !body?.success) {
    const msg =
      body?.errors?.map((e) => e.message).join("; ") || `Cloudflare API error (${res.status})`;
    throw new CloudflareApiError(msg, res.status, body?.errors);
  }
  return body.result;
}

export type CfZone = { id: string; name: string };

// Resolve the zone that owns `domain`. The zone is keyed by the registrable root
// (e.g. updates.acme.com lives in the acme.com zone). Returns null when the domain
// isn't in this Cloudflare account so the caller can show a clear message.
export async function findZone(token: string, domain: string): Promise<CfZone | null> {
  const root = registrableRoot(domain);
  const zones = await cfFetch<CfZone[]>(
    token,
    `/zones?name=${encodeURIComponent(root)}&status=active`,
  );
  return zones[0] ?? null;
}

type CfDnsRecord = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl?: number;
  priority?: number; // present on MX records
};

export type RecordAction = "created" | "updated" | "skipped" | "conflict" | "error";
export type RecordWriteResult = {
  record: DnsRecord;
  action: RecordAction;
  error?: string;
  // On "conflict": the value already published at that name, for the UI to show
  // alongside ours so the customer can decide which they want.
  existing?: string;
};

// Cloudflare stores TXT content wrapped in double quotes. Send it quoted so
// Cloudflare doesn't rewrite (and warn about) it, and compare quote-insensitively
// below so re-runs stay idempotent.
function quoteTxt(value: string): string {
  return value.startsWith('"') && value.endsWith('"') ? value : `"${value}"`;
}

function normalizeContent(type: string, content: string): string {
  if (type !== "TXT") return content;
  return content.startsWith('"') && content.endsWith('"') ? content.slice(1, -1) : content;
}

// proxied:false is CRITICAL — a proxied (orange-cloud) DKIM CNAME silently breaks
// mail authentication. ttl:1 means "automatic". MX records require a priority.
function toCfPayload(record: DnsRecord) {
  const content = record.type === "TXT" ? quoteTxt(record.value) : record.value;
  const base = { type: record.type, name: record.name, content, ttl: 1, proxied: false };
  return record.type === "MX" ? { ...base, priority: record.priority ?? 10 } : base;
}

// Render an existing Cloudflare record's value the way the customer would read it
// in their DNS panel (unquoted TXT; MX prefixed with its priority).
function describeExisting(match: CfDnsRecord): string {
  const content = normalizeContent(match.type, match.content);
  return match.type === "MX" && match.priority != null ? `${match.priority} ${content}` : content;
}

// Idempotent single-record write: skip an identical existing record, patch one
// that differs, otherwise create it. Safe to re-run (house rule: idempotency).
//
// One exception to "patch one that differs": a `group: "deliverability"` record
// (Return-Path MX/SPF, DMARC) lives at a name the customer may already be using —
// another email provider's bounce Return-Path, or their own DMARC policy. Silently
// overwriting those repoints another provider's feedback or downgrades a stricter
// policy, neither of which is ours to decide, so when the published *value* differs
// we report a "conflict" and leave the zone alone. A matching value with only the
// MX priority off is our own record, and still gets corrected. The DKIM CNAMEs are
// unambiguously ours (`<token>._domainkey`) so those always patch — and they're the
// only records verification actually depends on.
export async function upsertRecord(
  token: string,
  zoneId: string,
  record: DnsRecord,
): Promise<RecordWriteResult> {
  const existing = await cfFetch<CfDnsRecord[]>(
    token,
    `/zones/${zoneId}/dns_records?type=${record.type}&name=${encodeURIComponent(record.name)}`,
  );
  const match = existing.find((r) => r.name === record.name && r.type === record.type);
  const payload = toCfPayload(record);

  if (match) {
    const sameContent =
      normalizeContent(record.type, match.content) === normalizeContent(record.type, record.value);
    // Only CNAME/A/AAAA are proxiable; for TXT/MX, Cloudflare omits `proxied`, so
    // don't let that force a needless rewrite.
    const proxiedOk = record.type !== "CNAME" || match.proxied === false;
    // MX records also carry a priority — a right-host/wrong-priority record must
    // be patched, not skipped.
    const samePriority = record.type !== "MX" || match.priority === (record.priority ?? 10);
    if (sameContent && proxiedOk && samePriority) {
      return { record, action: "skipped" };
    }
    // Only a differing *value* means the record is somebody else's. A matching host
    // with the wrong MX priority is our own record needing a correction, so that
    // still patches.
    if (!sameContent && (record.group ?? "verify") === "deliverability") {
      return { record, action: "conflict", existing: describeExisting(match) };
    }
    await cfFetch(token, `/zones/${zoneId}/dns_records/${match.id}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    });
    return { record, action: "updated" };
  }

  await cfFetch(token, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
  return { record, action: "created" };
}

// Write every record, isolating per-record failures so one bad record doesn't
// abort the rest. Returns a per-record result for the UI.
export async function writeRecords(
  token: string,
  zoneId: string,
  records: DnsRecord[],
): Promise<RecordWriteResult[]> {
  const results: RecordWriteResult[] = [];
  for (const record of records) {
    try {
      results.push(await upsertRecord(token, zoneId, record));
    } catch (err) {
      results.push({
        record,
        action: "error",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}

export type CfTokens = {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO-8601
  scope?: string;
};

export type OAuthConfig = { clientId: string; clientSecret: string; tokenEndpoint: string };

// Exchange a refresh token for a fresh access token. Uses client_secret_basic
// (credentials in the Authorization header) to match the OAuth client config.
// Cloudflare may rotate the refresh token, so persist whatever comes back.
export async function refreshAccessToken(
  refreshToken: string,
  config: OAuthConfig,
): Promise<CfTokens> {
  return exchangeToken(
    { grant_type: "refresh_token", refresh_token: refreshToken },
    config,
    refreshToken,
  );
}

// Exchange an authorization code (PKCE) for the initial token set.
export async function exchangeAuthCode(
  params: { code: string; redirectUri: string; codeVerifier: string },
  config: OAuthConfig,
): Promise<CfTokens> {
  return exchangeToken(
    {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      code_verifier: params.codeVerifier,
    },
    config,
  );
}

async function exchangeToken(
  fields: Record<string, string>,
  config: OAuthConfig,
  fallbackRefresh?: string,
): Promise<CfTokens> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  const res = await fetch(config.tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basic}`,
    },
    body: new URLSearchParams(fields),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json?.access_token) {
    const msg =
      (json?.error_description as string) ||
      (json?.error as string) ||
      `Token request failed (${res.status})`;
    throw new Error(msg);
  }
  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : 3600;
  const refreshToken = (json.refresh_token as string) ?? fallbackRefresh ?? "";
  // A grant with no refresh token still *works* — right up until the access token
  // expires, at which point the connection is unrecoverable and every DNS write
  // fails with "reconnect Cloudflare". That's hours-to-days after consent, far from
  // the cause, so make the noise now. Usually means the OAuth client isn't
  // registered for `offline_access`: the authorization server grants only the
  // scopes its client is configured for and quietly drops the rest from `scope`,
  // so consent still succeeds and nothing looks wrong until much later.
  if (!refreshToken) {
    console.error(
      "[cloudflare-oauth] token response carried no refresh_token — this connection will " +
        `stop working in ~${expiresIn}s and will need manual reconsent. Granted scope: ` +
        `"${json.scope ?? "(none)"}". Check that offline_access is among the OAuth ` +
        "client's configured scopes.",
    );
  }
  return {
    accessToken: json.access_token as string,
    refreshToken,
    expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
    scope: json.scope as string | undefined,
  };
}
