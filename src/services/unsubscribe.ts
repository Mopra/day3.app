export type UnsubscribeTokenPayload = {
  accountId: string;
  subscriberId: string;
  email: string;
  campaignId?: string;
  campaignRecipientId?: string;
  /** Issued-at, epoch seconds. Set by signUnsubscribeToken; used to bound token age. */
  iat?: number;
};

// Tokens are embedded in every sent email and the List-Unsubscribe header, so a
// leaked token grants an unsubscribe-others capability. Bound their lifetime so
// it is not permanent. Default is generous (1 year) to stay compatible with
// mail clients that surface the List-Unsubscribe link long after delivery.
export const DEFAULT_UNSUBSCRIBE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

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

export async function signUnsubscribeToken(
  payload: UnsubscribeTokenPayload,
  secret: string,
): Promise<string> {
  // Stamp an issued-at (epoch seconds) so the verifier can enforce a max age.
  const signed: UnsubscribeTokenPayload = {
    ...payload,
    iat: payload.iat ?? Math.floor(Date.now() / 1000),
  };
  const body = new TextEncoder().encode(JSON.stringify(signed));
  const key = await hmacKey(secret, "sign");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `${base64UrlEncode(body)}.${base64UrlEncode(sig)}`;
}

export async function verifyUnsubscribeToken(
  token: string,
  secret: string,
  maxAgeSeconds: number = DEFAULT_UNSUBSCRIBE_MAX_AGE_SECONDS,
): Promise<UnsubscribeTokenPayload | null> {
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
    const payload = JSON.parse(new TextDecoder().decode(body)) as UnsubscribeTokenPayload;
    if (!payload.accountId || !payload.subscriberId || !payload.email) return null;
    // Enforce a bounded lifetime. An unstamped token predates this check and is
    // treated as over-age (we never issue tokens without iat).
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) return null;
    const ageSeconds = Math.floor(Date.now() / 1000) - payload.iat;
    if (ageSeconds > maxAgeSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}

export function unsubscribeUrl(appUrl: string, token: string): string {
  return `${appUrl.replace(/\/$/, "")}/unsubscribe?token=${encodeURIComponent(token)}`;
}
