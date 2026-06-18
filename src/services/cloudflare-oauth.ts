// Cloudflare OAuth (authorization-code + PKCE) glue: config, the PKCE/state
// helpers, the signed short-lived state cookie that bridges connect→callback, and
// token refresh/persist/revoke against the encrypted `dns_integrations` row.
//
// Endpoints are global (same for every client) and documented at
// developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare.
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { dnsIntegrations, type DnsIntegration } from "../db/schema";
import { decryptSecret, encryptSecret } from "../lib/crypto";
import { newId, nowIso } from "../lib/ids";
import {
  exchangeAuthCode,
  refreshAccessToken,
  type CfTokens,
  type OAuthConfig,
} from "./cloudflare-dns";

export const CF_STATE_COOKIE = "cf_oauth_state";
const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes to complete the consent flow
const TOKEN_SKEW_MS = 60 * 1000; // refresh a minute before the token actually expires

export type CloudflareOAuthConfig = OAuthConfig & {
  authorizeEndpoint: string;
  revokeEndpoint: string;
  userinfoEndpoint: string;
  redirectUri: string;
  scopes: string; // space-separated; may be empty (then Cloudflare uses the client's configured scopes)
};

export function getCloudflareOAuthConfig(): CloudflareOAuthConfig {
  const clientId = process.env.CLOUDFLARE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.CLOUDFLARE_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error("Cloudflare OAuth is not configured (CLOUDFLARE_OAUTH_CLIENT_ID/SECRET)");
  }
  return {
    clientId,
    clientSecret,
    authorizeEndpoint:
      process.env.CLOUDFLARE_OAUTH_AUTHORIZE_ENDPOINT ?? "https://dash.cloudflare.com/oauth2/auth",
    tokenEndpoint:
      process.env.CLOUDFLARE_OAUTH_TOKEN_ENDPOINT ?? "https://dash.cloudflare.com/oauth2/token",
    revokeEndpoint:
      process.env.CLOUDFLARE_OAUTH_REVOKE_ENDPOINT ?? "https://dash.cloudflare.com/oauth2/revoke",
    userinfoEndpoint:
      process.env.CLOUDFLARE_OAUTH_USERINFO_ENDPOINT ?? "https://dash.cloudflare.com/oauth2/userinfo",
    redirectUri: process.env.CLOUDFLARE_OAUTH_REDIRECT_URI ?? "",
    scopes: process.env.CLOUDFLARE_OAUTH_SCOPES ?? "",
  };
}

/* --- PKCE + state primitives --------------------------------------------- */

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlDecode(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomToken(bytes = 32): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return base64UrlEncode(buf);
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return base64UrlEncode(digest);
}

export function buildAuthorizeUrl(
  config: CloudflareOAuthConfig,
  params: { state: string; codeChallenge: string },
): string {
  const url = new URL(config.authorizeEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (config.scopes) url.searchParams.set("scope", config.scopes);
  return url.toString();
}

/* --- signed state cookie (HMAC, mirrors services/unsubscribe.ts) ---------- */

export type OAuthStatePayload = {
  state: string;
  codeVerifier: string;
  accountId: string;
  returnTo: string;
  exp: number; // epoch ms
};

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signState(payload: OAuthStatePayload, secret: string): Promise<string> {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const key = await hmacKey(secret, "sign");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `${base64UrlEncode(body)}.${base64UrlEncode(sig)}`;
}

export async function verifyState(token: string, secret: string): Promise<OAuthStatePayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const body = base64UrlDecode(parts[0]);
    const sig = base64UrlDecode(parts[1]);
    const key = await hmacKey(secret, "verify");
    const valid = await crypto.subtle.verify("HMAC", key, sig.slice().buffer, body.slice().buffer);
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(body)) as OAuthStatePayload;
    if (!payload.state || !payload.codeVerifier || !payload.accountId) return null;
    if (typeof payload.exp !== "number" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function newStatePayload(accountId: string, returnTo: string, verifier: string, state: string): OAuthStatePayload {
  return { state, codeVerifier: verifier, accountId, returnTo, exp: Date.now() + STATE_TTL_MS };
}

/* --- token storage -------------------------------------------------------- */

// Store the (encrypted) token set, creating or refreshing the account's single
// Cloudflare connection. Used by the callback and the refresh path.
export async function saveTokens(
  db: Db,
  accountId: string,
  tokens: CfTokens,
  label?: string | null,
): Promise<void> {
  const existing = await db.query.dnsIntegrations.findFirst({
    where: and(eq(dnsIntegrations.accountId, accountId), eq(dnsIntegrations.provider, "cloudflare")),
  });
  const now = nowIso();
  const base = {
    accessTokenEnc: await encryptSecret(tokens.accessToken),
    refreshTokenEnc: await encryptSecret(tokens.refreshToken),
    expiresAt: tokens.expiresAt,
    scope: tokens.scope ?? existing?.scope ?? null,
    status: "connected" as const,
    updatedAt: now,
  };
  if (existing) {
    await db
      .update(dnsIntegrations)
      .set({ ...base, cfAccountLabel: label ?? existing.cfAccountLabel })
      .where(eq(dnsIntegrations.id, existing.id));
    return;
  }
  await db.insert(dnsIntegrations).values({
    id: newId("dnsint"),
    accountId,
    provider: "cloudflare",
    cfAccountLabel: label ?? null,
    createdAt: now,
    ...base,
  });
}

// Return a usable access token, transparently refreshing (and persisting the
// rotated tokens) when the stored one is expired or about to expire.
export async function getValidAccessToken(db: Db, integration: DnsIntegration): Promise<string> {
  const expMs = integration.expiresAt ? new Date(integration.expiresAt).getTime() : 0;
  if (expMs - TOKEN_SKEW_MS > Date.now()) {
    return decryptSecret(integration.accessTokenEnc);
  }
  const config = getCloudflareOAuthConfig();
  const refreshToken = await decryptSecret(integration.refreshTokenEnc);
  const tokens = await refreshAccessToken(refreshToken, config);
  await saveTokens(db, integration.accountId, tokens, integration.cfAccountLabel);
  return tokens.accessToken;
}

export async function completeAuthCode(
  db: Db,
  accountId: string,
  params: { code: string; codeVerifier: string },
  config: CloudflareOAuthConfig,
): Promise<void> {
  const tokens = await exchangeAuthCode(
    { code: params.code, redirectUri: config.redirectUri, codeVerifier: params.codeVerifier },
    config,
  );
  const label = await fetchUserInfo(tokens.accessToken, config);
  await saveTokens(db, accountId, tokens, label);
}

// Best-effort display label ("Connected as …") for the connected account. We
// don't request identity scopes, so this only populates if the token is allowed
// to read userinfo; any failure returns null and the connection works regardless.
export async function fetchUserInfo(
  accessToken: string,
  config: CloudflareOAuthConfig,
): Promise<string | null> {
  try {
    const res = await fetch(config.userinfoEndpoint, {
      headers: { Authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Record<string, unknown>;
    // Cloudflare wraps API payloads in { result }; userinfo may be flat — handle both.
    const data = (body.result ?? body) as Record<string, unknown>;
    const label = data.email ?? data.name ?? data.sub ?? null;
    return typeof label === "string" ? label : null;
  } catch {
    return null;
  }
}

// Best-effort token revocation on disconnect — failure here must not block
// deleting our local record.
export async function revokeToken(token: string, config: CloudflareOAuthConfig): Promise<void> {
  const basic = Buffer.from(`${config.clientId}:${config.clientSecret}`).toString("base64");
  try {
    await fetch(config.revokeEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Basic ${basic}`,
      },
      body: new URLSearchParams({ token }),
    });
  } catch (err) {
    console.error("[cloudflare-oauth] token revocation failed", err);
  }
}
