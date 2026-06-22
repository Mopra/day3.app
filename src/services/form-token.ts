// Confirmation tokens for double opt-in signup forms. Same construction as the
// unsubscribe token (HMAC-SHA256 over a JSON payload, base64url body.sig) and
// signed with the same UNSUBSCRIBE_SECRET — both are low-stakes, single-purpose
// capability links embedded in outbound mail. A leaked confirm token only lets
// someone confirm an address they already control the inbox for, so the risk is
// minimal; we still bound the lifetime.

export type FormConfirmTokenPayload = {
  accountId: string;
  subscriberId: string;
  formId: string;
  email: string;
  /** Issued-at, epoch seconds. Set by signFormConfirmToken; bounds token age. */
  iat?: number;
};

// Confirmation links are clicked within minutes/hours of signup in practice; 30
// days is a generous ceiling that still expires abandoned pending rows' links.
export const DEFAULT_FORM_CONFIRM_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;

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

export async function signFormConfirmToken(
  payload: FormConfirmTokenPayload,
  secret: string,
): Promise<string> {
  const signed: FormConfirmTokenPayload = {
    ...payload,
    iat: payload.iat ?? Math.floor(Date.now() / 1000),
  };
  const body = new TextEncoder().encode(JSON.stringify(signed));
  const key = await hmacKey(secret, "sign");
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, body));
  return `${base64UrlEncode(body)}.${base64UrlEncode(sig)}`;
}

export async function verifyFormConfirmToken(
  token: string,
  secret: string,
  maxAgeSeconds: number = DEFAULT_FORM_CONFIRM_MAX_AGE_SECONDS,
): Promise<FormConfirmTokenPayload | null> {
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
    const payload = JSON.parse(new TextDecoder().decode(body)) as FormConfirmTokenPayload;
    if (!payload.accountId || !payload.subscriberId || !payload.formId || !payload.email) {
      return null;
    }
    if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) return null;
    const ageSeconds = Math.floor(Date.now() / 1000) - payload.iat;
    if (ageSeconds > maxAgeSeconds) return null;
    return payload;
  } catch {
    return null;
  }
}
