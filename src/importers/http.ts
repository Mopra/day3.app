import { canonicalizeEmail, isValidEmail } from "../lib/csv";
import { slugifyFieldKey } from "../lib/form-fields";
import { PROVIDER_CATALOG, type ProviderId } from "./catalog";
import type { MappedStatus, ProviderContext, ProviderRecord } from "./types";

export type ProviderErrorCode =
  | "bad_key"
  | "no_access"
  | "not_found"
  | "rate_limited"
  | "bad_request"
  | "upstream";

// A failure talking to a provider, with a message written for the person who
// pasted the key. It never contains the key. `code` lets the UI offer the CSV
// fallback when the API is simply not available to them (bad_key / no_access).
export class ImportProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ImportProviderError";
  }
}

const DEFAULT_MAX_ATTEMPTS = 6;
const DEFAULT_MAX_WAIT_MS = 130_000;
const REQUEST_TIMEOUT_MS = 30_000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function messageFor(provider: ProviderId, code: ProviderErrorCode, status?: number): string {
  const label = PROVIDER_CATALOG[provider].label;
  const noun = PROVIDER_CATALOG[provider].sourceNoun;
  switch (code) {
    case "bad_key":
      return `${label} did not accept that API key. Check that you copied all of it and that it has not been deleted.`;
    case "no_access":
      return provider === "beehiiv"
        ? "This beehiiv key cannot read subscribers. Not every beehiiv plan includes API access; if yours does not, export a CSV instead."
        : `This ${label} key is not allowed to read subscribers. Create a key with full or read access, or export a CSV instead.`;
    case "not_found":
      return `${label} could not find that ${noun}. It may have been deleted, or the key belongs to a different account.`;
    case "rate_limited":
      return `${label} is limiting how fast we can read your list. Wait a few minutes and start the import again; contacts already imported are kept.`;
    case "bad_request":
      return `${label} refused the request (HTTP ${status ?? 400}). Start the import again, and contact support if it keeps happening.`;
    case "upstream":
      return `${label} is not responding right now${status ? ` (HTTP ${status})` : ""}. Try again in a few minutes.`;
  }
}

export function providerError(
  provider: ProviderId,
  code: ProviderErrorCode,
  status?: number,
): ImportProviderError {
  return new ImportProviderError(code, messageFor(provider, code, status));
}

// How long a 429 asks us to wait. Retry-After is seconds (or an HTTP date);
// beehiiv's RateLimit-Reset is an epoch second, other APIs send a delta. Falls
// back to exponential backoff with jitter.
export function retryDelayMs(res: Response | null, attempt: number, now = Date.now()): number {
  const fallback = Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 250);
  if (!res) return fallback;
  const retryAfter = res.headers.get("retry-after");
  if (retryAfter) {
    const secs = Number(retryAfter);
    if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) return Math.max(0, at - now);
  }
  const reset = res.headers.get("ratelimit-reset") ?? res.headers.get("x-ratelimit-reset");
  if (reset) {
    const n = Number(reset);
    if (Number.isFinite(n)) {
      // An epoch timestamp is far larger than any sane delta.
      return n > 1_000_000_000 ? Math.max(0, n * 1000 - now) + 250 : n * 1000;
    }
  }
  return fallback;
}

/**
 * GET a provider URL as JSON, retrying 429s, 5xx and network failures with
 * backoff, and turning every other failure into an ImportProviderError the user
 * can act on. 401 is a bad key, 403 is "this key/plan has no API access", 404 is
 * a missing list.
 */
export async function providerGet<T>(
  provider: ProviderId,
  ctx: ProviderContext,
  url: string,
  headers: Record<string, string>,
): Promise<T> {
  const doFetch = ctx.fetch ?? fetch;
  const sleep = ctx.sleep ?? defaultSleep;
  const maxAttempts = ctx.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const maxWait = ctx.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;

  let lastCode: ProviderErrorCode = "upstream";
  let lastStatus: number | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let res: Response | null = null;
    try {
      res = await doFetch(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: "error",
      });
    } catch {
      // Network failure or timeout: retry like a 5xx.
      lastCode = "upstream";
      lastStatus = undefined;
    }

    if (res) {
      if (res.ok) {
        try {
          return (await res.json()) as T;
        } catch {
          throw providerError(provider, "upstream", res.status);
        }
      }
      // Drain the body so the connection can be reused; never surface it (it
      // could echo request details back).
      await res.text().catch(() => "");
      if (res.status === 401) throw providerError(provider, "bad_key", 401);
      if (res.status === 403) throw providerError(provider, "no_access", 403);
      if (res.status === 404) throw providerError(provider, "not_found", 404);
      if (res.status === 429) {
        lastCode = "rate_limited";
      } else if (res.status >= 500) {
        lastCode = "upstream";
      } else {
        throw providerError(provider, "bad_request", res.status);
      }
      lastStatus = res.status;
    }

    if (attempt === maxAttempts - 1) break;
    const wait = retryDelayMs(res, attempt);
    if (wait > maxWait) break;
    await sleep(wait);
  }
  throw providerError(provider, lastCode, lastStatus);
}

// ---------------------------------------------------------------------------
// Record mapping helpers shared by the providers.

const MAX_ATTR_VALUE_LEN = 500;

const FIRST_NAME_KEYS = new Set(["first_name", "firstname", "fname", "first", "name", "fornavn"]);
const LAST_NAME_KEYS = new Set(["last_name", "lastname", "lname", "last", "surname", "efternavn"]);

function stringify(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    const joined = value.map((v) => String(v)).join(", ");
    return joined || null;
  }
  const s = String(value).trim();
  return s || null;
}

/** Parse a provider timestamp (ISO, "YYYY-MM-DD HH:mm:ss" UTC, or epoch seconds). */
export function toIso(value: unknown): string | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  if (typeof value === "number") {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  const s = String(value).trim();
  // "2021-09-01 14:03:50" carries no zone; the APIs that send it mean UTC.
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(s) ? `${s.replace(" ", "T")}Z` : s;
  const ms = Date.parse(normalized);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

/**
 * Build one import record from a provider contact: canonical email, a status
 * mapped by the provider, and custom fields. Name-like fields become first/last
 * name; every other field becomes a custom attribute keyed by a slug of its name,
 * the same rule CSV headers follow.
 */
export function buildRecord(input: {
  email: unknown;
  status: MappedStatus;
  firstName?: unknown;
  lastName?: unknown;
  fields?: Record<string, unknown> | Array<{ name: string; value: unknown }>;
  createdAt?: unknown;
  unsubscribedAt?: unknown;
}): ProviderRecord {
  const email = typeof input.email === "string" ? canonicalizeEmail(input.email) : "";
  if (!email || !isValidEmail(email)) return { kind: "skip", reason: "invalid" };
  if (input.status === "skip") return { kind: "skip", reason: "status" };

  let firstName = stringify(input.firstName) ?? undefined;
  let lastName = stringify(input.lastName) ?? undefined;
  const attributes: Record<string, string> = {};
  const entries: Array<[string, unknown]> = Array.isArray(input.fields)
    ? input.fields.map((f) => [f.name, f.value])
    : Object.entries(input.fields ?? {});
  for (const [name, raw] of entries) {
    const value = stringify(raw);
    if (!value) continue;
    const key = slugifyFieldKey(name);
    if (!key) continue;
    if (FIRST_NAME_KEYS.has(key)) {
      firstName ??= value;
      continue;
    }
    if (LAST_NAME_KEYS.has(key)) {
      lastName ??= value;
      continue;
    }
    if (key === "email" || key === "email_address") continue;
    attributes[key] = value.slice(0, MAX_ATTR_VALUE_LEN);
  }

  return {
    kind: "row",
    row: {
      email,
      firstName,
      lastName,
      status: input.status,
      unsubscribedAt: input.status === "unsubscribed" ? toIso(input.unsubscribedAt) : undefined,
      attributes: Object.keys(attributes).length > 0 ? attributes : undefined,
      createdAt: toIso(input.createdAt),
    },
  };
}

export function withQuery(base: string, params: Record<string, string | number | undefined | null>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") url.searchParams.append(k, String(v));
  }
  return url.toString();
}
