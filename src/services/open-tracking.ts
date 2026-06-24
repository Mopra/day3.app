import { sql } from "drizzle-orm";
import type { Db } from "../db/client";
import { newId, nowIso } from "../lib/ids";

// Engagement tracking — opens and clicks. Both embed an HMAC-signed token (same
// scheme + secret as the unsubscribe link) identifying the recipient:
//   • Opens: a 1×1 pixel; a load records the open.
//   • Clicks: content links are rewritten to redirect through us; the token also
//     carries the (signed) destination URL so the redirect can only ever go to a
//     URL we issued — never an attacker-supplied open redirect.
// Attributing engagement is low-stakes, but signing keeps a leaked recipient id
// from being used to forge opens/clicks for someone else.
export type OpenTrackingTokenPayload = {
  accountId: string;
  campaignId: string;
  campaignRecipientId: string;
  email: string;
  /** Issued-at, epoch seconds. Set by signOpenToken; used to bound token age. */
  iat?: number;
};

// Opens trickle in for days after a send (and clients re-fetch images long
// after), so the bound is generous. A pixel older than this simply stops
// recording — the capability shouldn't live forever.
export const DEFAULT_OPEN_TOKEN_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

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

async function hmacKey(secret: string, usage: "sign" | "verify"): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    [usage],
  );
}

export async function signOpenToken(
  payload: OpenTrackingTokenPayload,
  secret: string,
): Promise<string> {
  const signed: OpenTrackingTokenPayload = {
    ...payload,
    iat: payload.iat ?? Math.floor(Date.now() / 1000),
  };
  const body = new TextEncoder().encode(JSON.stringify(signed));
  const key = await hmacKey(secret, "sign");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `${base64UrlEncode(body)}.${base64UrlEncode(sig)}`;
}

export async function verifyOpenToken(
  token: string,
  secret: string,
  maxAgeSeconds: number = DEFAULT_OPEN_TOKEN_MAX_AGE_SECONDS,
): Promise<OpenTrackingTokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const body = base64UrlDecode(parts[0]);
    const sig = base64UrlDecode(parts[1]);
    const key = await hmacKey(secret, "verify");
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sig.slice().buffer,
      body.slice().buffer,
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(body)) as OpenTrackingTokenPayload;
    if (!payload.accountId || !payload.campaignRecipientId || !payload.email) return null;
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) return null;
    const ageSeconds = Math.floor(Date.now() / 1000) - payload.iat;
    if (ageSeconds > maxAgeSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

export function openTrackingUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/track/open?t=${encodeURIComponent(token)}`;
}

// Records a recipient's first open: stamps opened_at (once) and writes one
// `open` email_event. The `opened_at IS NULL` guard makes every later pixel
// load — clients re-fetch images, privacy proxies prefetch them — a no-op, so we
// count exactly one open per recipient and never inflate the number. An unknown
// or already-opened recipient updates nothing and records no event.
export async function recordOpen(db: Db, payload: OpenTrackingTokenPayload): Promise<void> {
  const now = nowIso();
  // One round-trip: the data-modifying CTE stamps opened_at (first-open only, via
  // the `opened_at IS NULL` guard) and the INSERT fires exactly when that UPDATE
  // returned a row — so a re-fetched pixel, an unknown id, or another account's
  // id all no-op without a second statement. Collapsing the old UPDATE-then-
  // INSERT pair matters on the hot path: the web tier runs on a tiny per-instance
  // Postgres pool, so halving the connection hold time per pixel directly raises
  // how many opens an instance can absorb during a large campaign's open storm.
  await db.execute(sql`
    WITH upd AS (
      UPDATE campaign_recipients
      SET opened_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
      WHERE id = ${payload.campaignRecipientId}
        AND account_id = ${payload.accountId}
        AND opened_at IS NULL
      RETURNING id
    )
    INSERT INTO email_events
      (id, account_id, campaign_id, campaign_recipient_id, event_type, email, provider, created_at)
    SELECT ${newId("evt")}, ${payload.accountId}, ${payload.campaignId},
           ${payload.campaignRecipientId}, 'open', ${payload.email}, 'ses', ${now}::timestamptz
    FROM upd
  `);
}

/* ─────────────────────────────── clicks ─────────────────────────────── */

export type ClickTrackingTokenPayload = {
  accountId: string;
  campaignId: string;
  campaignRecipientId: string;
  email: string;
  /** The real destination — signed in, so the redirect can't be tampered with. */
  url: string;
  /** Issued-at, epoch seconds. Set by signClickToken; bounds token age. */
  iat?: number;
};

export const DEFAULT_CLICK_TOKEN_MAX_AGE_SECONDS = 180 * 24 * 60 * 60;

export async function signClickToken(
  payload: ClickTrackingTokenPayload,
  secret: string,
): Promise<string> {
  const signed: ClickTrackingTokenPayload = {
    ...payload,
    iat: payload.iat ?? Math.floor(Date.now() / 1000),
  };
  const body = new TextEncoder().encode(JSON.stringify(signed));
  const key = await hmacKey(secret, "sign");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `${base64UrlEncode(body)}.${base64UrlEncode(sig)}`;
}

export async function verifyClickToken(
  token: string,
  secret: string,
  maxAgeSeconds: number = DEFAULT_CLICK_TOKEN_MAX_AGE_SECONDS,
): Promise<ClickTrackingTokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const body = base64UrlDecode(parts[0]);
    const sig = base64UrlDecode(parts[1]);
    const key = await hmacKey(secret, "verify");
    const valid = await crypto.subtle.verify(
      "HMAC",
      key,
      sig.slice().buffer,
      body.slice().buffer,
    );
    if (!valid) return null;
    const payload = JSON.parse(new TextDecoder().decode(body)) as ClickTrackingTokenPayload;
    if (!payload.accountId || !payload.campaignRecipientId || !payload.email) return null;
    // The redirect target must be an absolute http(s) URL. Refuse anything else
    // (mailto:, javascript:, relative, …) so a forged or malformed token can
    // never coerce the redirect into something unsafe.
    if (typeof payload.url !== "string" || !/^https?:\/\//i.test(payload.url)) return null;
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) return null;
    const ageSeconds = Math.floor(Date.now() / 1000) - payload.iat;
    if (ageSeconds > maxAgeSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

export function clickTrackingUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/api/track/click?t=${encodeURIComponent(token)}`;
}

// Records a click: stamps clicked_at (once) and writes one `click` event. Because
// a click is also proof the email was opened, it back-fills opened_at too — so a
// recipient who blocks the pixel but clicks a link still counts as an open. Both
// stamps are first-time-only, so repeat clicks never inflate either count. An
// unknown or other-account recipient updates nothing.
export async function recordClick(db: Db, payload: ClickTrackingTokenPayload): Promise<void> {
  const now = nowIso();
  // Click stamp + click event in one round-trip (same CTE pattern as recordOpen):
  // the `clicked_at IS NULL` guard makes repeat clicks no-op, so the count never
  // inflates and an unknown/other-account id writes nothing.
  await db.execute(sql`
    WITH upd AS (
      UPDATE campaign_recipients
      SET clicked_at = ${now}::timestamptz, updated_at = ${now}::timestamptz
      WHERE id = ${payload.campaignRecipientId}
        AND account_id = ${payload.accountId}
        AND clicked_at IS NULL
      RETURNING id
    )
    INSERT INTO email_events
      (id, account_id, campaign_id, campaign_recipient_id, event_type, email, provider, payload_json, created_at)
    SELECT ${newId("evt")}, ${payload.accountId}, ${payload.campaignId},
           ${payload.campaignRecipientId}, 'click', ${payload.email}, 'ses',
           ${JSON.stringify({ url: payload.url })}, ${now}::timestamptz
    FROM upd
  `);

  // A click is also proof of an open, so back-fill opened_at + an open event
  // (first-open only). One more round-trip — down from the old three.
  await recordOpen(db, {
    accountId: payload.accountId,
    campaignId: payload.campaignId,
    campaignRecipientId: payload.campaignRecipientId,
    email: payload.email,
  });
}
