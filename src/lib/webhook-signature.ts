import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

// Signing for outbound webhooks.
//
// Scheme (Stripe-shaped, because that is the one every backend developer has
// already implemented once):
//
//   Day3-Signature: t=1755264000,v1=<hex hmac-sha256>
//
// where the MAC is taken over `${t}.${rawBody}` using the endpoint's secret.
// Two properties matter and both come from including `t` in the signed string:
//
//   1. The receiver can reject stale deliveries (replay) by bounding |now - t|,
//      and the bound is theirs to choose — we don't guess it for them.
//   2. `t` cannot be tampered with independently of the body, so an attacker
//      cannot re-date a captured payload.
//
// The header carries a version tag (`v1=`) so a future scheme can be added
// alongside rather than swapped under receivers who verify by exact string.

export const SIGNATURE_HEADER = "Day3-Signature";
export const EVENT_ID_HEADER = "Day3-Event-Id";
export const EVENT_TYPE_HEADER = "Day3-Event-Type";
export const DELIVERY_ATTEMPT_HEADER = "Day3-Delivery-Attempt";

// `whsec_` prefixed so a leaked secret is greppable and obviously ours, and so
// it can never be confused with an API key (`day3_…`) in a config file. 32 bytes
// of entropy, base64url so it survives env files and JSON without escaping.
export const WEBHOOK_SECRET_PREFIX = "whsec_";

export function generateWebhookSecret(): string {
  return WEBHOOK_SECRET_PREFIX + randomBytes(32).toString("base64url");
}

/** The exact string that gets MAC'd. Exported so the docs and tests can't drift from it. */
export function signingPayload(timestampSeconds: number, rawBody: string): string {
  return `${timestampSeconds}.${rawBody}`;
}

export function computeSignature(secret: string, timestampSeconds: number, rawBody: string): string {
  return createHmac("sha256", secret).update(signingPayload(timestampSeconds, rawBody)).digest("hex");
}

/** The full `Day3-Signature` header value. */
export function signatureHeader(secret: string, timestampSeconds: number, rawBody: string): string {
  return `t=${timestampSeconds},v1=${computeSignature(secret, timestampSeconds, rawBody)}`;
}

// Constant-time compare of two hex digests. Length is checked first because
// timingSafeEqual throws (rather than returning false) on a length mismatch —
// and a length mismatch leaks nothing anyway, the digest length is fixed.
function hexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

/**
 * Verify a `Day3-Signature` header. Used by our own tests and by the docs'
 * reference snippet — receivers implement their own, but having the canonical
 * verifier in-tree means the documented algorithm is the one we actually sign
 * with.
 *
 * `toleranceSeconds` bounds replay; pass 0 to skip the freshness check.
 */
export function verifySignature(opts: {
  header: string | null | undefined;
  secret: string;
  rawBody: string;
  toleranceSeconds?: number;
  nowSeconds?: number;
}): boolean {
  const { header, secret, rawBody } = opts;
  if (!header) return false;

  let t: number | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") t = Number(value);
    // Collect every v1 element: a rotation could legitimately send two.
    else if (key === "v1") signatures.push(value);
  }
  if (t === undefined || !Number.isFinite(t) || signatures.length === 0) return false;

  const tolerance = opts.toleranceSeconds ?? 300;
  if (tolerance > 0) {
    const now = opts.nowSeconds ?? Math.floor(Date.now() / 1000);
    if (Math.abs(now - t) > tolerance) return false;
  }

  const expected = computeSignature(secret, t, rawBody);
  return signatures.some((s) => hexEqual(s, expected));
}
