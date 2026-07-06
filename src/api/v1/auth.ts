import { createHash, randomBytes } from "node:crypto";
import { and, eq, isNull, lt, or } from "drizzle-orm";
import { getDb, type Db } from "../../db/client";
import { accounts, apiKeys, type Account, type ApiKey } from "../../db/schema";
import { nowIso } from "../../lib/ids";
import { ApiError } from "./errors";

// Bearer-key authentication for the public API. Keys look like
// `day3_live_<40 base62 chars>`; only their SHA-256 hash is stored (api_keys
// table), so a DB leak never leaks usable credentials. `day3_test_…` is
// reserved in the format from day one (secret scanners should recognize both)
// but not implemented — using one gets a clear error, not a silent live hit.

const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const KEY_RANDOM_LEN = 40;
const KEY_RE = /^day3_(live|test)_[A-Za-z0-9]{40}$/;
// How much of the full key the settings UI may show ("day3_live_x7Kj9mP2…").
const DISPLAY_PREFIX_LEN = "day3_live_".length + 8;

export function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const bytes = randomBytes(KEY_RANDOM_LEN);
  let secret = "";
  for (const b of bytes) secret += KEY_ALPHABET[b % KEY_ALPHABET.length];
  const key = `day3_live_${secret}`;
  return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, DISPLAY_PREFIX_LEN) };
}

export type ApiContext = { db: Db; account: Account; apiKey: ApiKey };

// Resolve `Authorization: Bearer day3_live_…` → the owning account. The account
// always comes from the key (server-side), never from the request — the same
// tenant-scoping guarantee requireAccount() gives the session routes.
export async function requireApiKey(req: Request): Promise<ApiContext> {
  const header = req.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) {
    throw new ApiError(401, "invalid_api_key", "Missing API key. Pass `Authorization: Bearer day3_live_…`.");
  }
  const raw = match[1];
  if (!KEY_RE.test(raw)) {
    throw new ApiError(401, "invalid_api_key", "Invalid API key.");
  }
  if (raw.startsWith("day3_test_")) {
    throw new ApiError(
      403,
      "test_keys_not_supported",
      "Test-mode keys are not supported yet. Use a live key (day3_live_…).",
    );
  }

  const db = getDb();
  const key = await db.query.apiKeys.findFirst({
    where: eq(apiKeys.keyHash, hashApiKey(raw)),
  });
  if (!key) throw new ApiError(401, "invalid_api_key", "Invalid API key.");
  if (key.revokedAt) throw new ApiError(401, "revoked_api_key", "This API key has been revoked.");

  const account = await db.query.accounts.findFirst({ where: eq(accounts.id, key.accountId) });
  if (!account) throw new ApiError(401, "invalid_api_key", "Invalid API key.");

  // last_used_at, throttled to one write per minute per key. The WHERE clause
  // does the throttling atomically so concurrent requests don't stack writes.
  const cutoff = new Date(Date.now() - 60_000).toISOString();
  await db
    .update(apiKeys)
    .set({ lastUsedAt: nowIso() })
    .where(and(eq(apiKeys.id, key.id), or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, cutoff))));

  return { db, account, apiKey: key };
}
