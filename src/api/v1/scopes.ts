import type { ApiKey } from "../../db/schema";
import { ApiError } from "./errors";

// API-key scopes.
//
// The public API's base grant is deliberately wide: a key can read and write
// content — audiences, contacts, fields, segments, topics, campaign drafts. That
// matches what a key was allowed to do before scopes existed, so adding this
// column changed nothing for keys already in the wild.
//
// A scope exists for one reason: an action that spends real sending reputation
// and cannot be undone. There is exactly one today.
//
//   campaigns:send — submit, schedule, or send a campaign to its audience.
//
// This matters more for the MCP server than for a script. A script does what its
// author wrote; an agent holding the same key decides for itself, and "email
// everyone on the list" is not a decision to hand over by default. So the scope
// is opt-in at key creation and cannot be added to an existing key — you mint a
// new one, which keeps the grant visible in the key list rather than buried in
// an edit history.
//
// Test sends are NOT scoped. They reach addresses the caller names (capped and
// rate-limited), never the audience, and they are the whole point of letting an
// agent iterate on an email.

export const API_SCOPES = ["campaigns:send"] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

// Parse the stored JSON array. A null column (every pre-scopes key), malformed
// JSON, or an unknown entry all degrade to "no elevated scopes" — the safe
// direction, and the only one that can't turn a storage bug into a send.
export function parseScopes(raw: string | null | undefined): ApiScope[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is ApiScope => typeof s === "string" && isApiScope(s));
  } catch {
    return [];
  }
}

export function serializeScopes(scopes: ApiScope[]): string {
  return JSON.stringify([...new Set(scopes)]);
}

export function keyHasScope(key: Pick<ApiKey, "scopes">, scope: ApiScope): boolean {
  return parseScopes(key.scopes).includes(scope);
}

// Guard for a scoped route. The message names the fix (mint a key that has it)
// because the caller is often an agent relaying the error to a human who has to
// go and do exactly that.
export function requireScope(key: Pick<ApiKey, "scopes">, scope: ApiScope): void {
  if (keyHasScope(key, scope)) return;
  throw new ApiError(
    403,
    "insufficient_scope",
    `This API key is missing the \`${scope}\` scope. Sending is off by default: create a new key with sending enabled in Day3 under API keys.`,
  );
}
