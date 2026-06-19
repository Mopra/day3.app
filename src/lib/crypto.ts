// AES-256-GCM encryption for secrets at rest — specifically the Cloudflare OAuth
// access/refresh tokens, which are credentials to a customer's DNS and must never
// be stored in plaintext.
//
// Ciphertext layout (versioned): `<keyId>.<base64( iv[12] || ciphertext+tag )>`.
// The leading key id lets multiple keys coexist during a rotation: new rows are
// written with the active key, while old rows can still be read with their
// original key until they are re-encrypted. Decryption selects the key by id and
// FAILS CLOSED (clear error, no plaintext) if that id is unknown.
//
// Keys are configured as a keyring:
//   - DNS_TOKEN_ENC_KEYS  — comma-separated `id:base64key` pairs, e.g.
//                           "v1:<base64>,v2:<base64>". Every key listed can be
//                           used to DECRYPT; rotation = add the new key here.
//   - DNS_TOKEN_ENC_ACTIVE_KEY_ID — which key id ENCRYPTS new ciphertext.
// For backward compatibility a single DNS_TOKEN_ENC_KEY is still accepted and is
// treated as the keyring `{ v1: <key> }` with active id "v1" — i.e. existing
// ciphertext (which was written before versioning) is read as key id "v1".

const IV_BYTES = 12; // standard GCM nonce length

// The implicit key id assigned to a bare DNS_TOKEN_ENC_KEY and to legacy,
// pre-versioning ciphertext that has been migrated to carry a prefix.
export const LEGACY_KEY_ID = "v1";

// Return an ArrayBuffer-backed view (not the SharedArrayBuffer-typed Buffer) so
// it satisfies WebCrypto's BufferSource parameter types.
function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(b64, "base64");
  const out = new Uint8Array(buf.length);
  out.set(buf);
  return out;
}

function bytesToB64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyB64);
  if (raw.length !== 32) {
    throw new Error("DNS token encryption key must decode to 32 bytes (a base64-encoded AES-256 key)");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export type Keyring = {
  /** key id → base64-encoded 32-byte key (every entry can decrypt) */
  keys: Record<string, string>;
  /** the key id used to encrypt new ciphertext */
  activeKeyId: string;
};

/**
 * Resolve the keyring from the environment. Accepts (in priority order):
 *  1. DNS_TOKEN_ENC_KEYS (+ DNS_TOKEN_ENC_ACTIVE_KEY_ID) — the rotation-aware form.
 *  2. DNS_TOKEN_ENC_KEY — the single-key legacy form, mapped to id "v1".
 * Throws (fails closed) when nothing usable is configured.
 */
export function resolveKeyring(env: NodeJS.ProcessEnv = process.env): Keyring {
  const multi = env.DNS_TOKEN_ENC_KEYS?.trim();
  if (multi) {
    const keys: Record<string, string> = {};
    for (const pair of multi.split(",")) {
      const trimmed = pair.trim();
      if (!trimmed) continue;
      const idx = trimmed.indexOf(":");
      if (idx <= 0) {
        throw new Error(`DNS_TOKEN_ENC_KEYS entry is malformed (expected "id:base64key"): ${trimmed.slice(0, 8)}…`);
      }
      const id = trimmed.slice(0, idx).trim();
      const keyB64 = trimmed.slice(idx + 1).trim();
      if (!id || !keyB64) {
        throw new Error('DNS_TOKEN_ENC_KEYS entry is malformed (empty id or key)');
      }
      keys[id] = keyB64;
    }
    const ids = Object.keys(keys);
    if (ids.length === 0) throw new Error("DNS_TOKEN_ENC_KEYS is set but contains no keys");
    const activeKeyId = env.DNS_TOKEN_ENC_ACTIVE_KEY_ID?.trim() || ids[ids.length - 1];
    if (!keys[activeKeyId]) {
      throw new Error(`DNS_TOKEN_ENC_ACTIVE_KEY_ID "${activeKeyId}" is not present in DNS_TOKEN_ENC_KEYS`);
    }
    return { keys, activeKeyId };
  }
  const single = env.DNS_TOKEN_ENC_KEY?.trim();
  if (single) {
    return { keys: { [LEGACY_KEY_ID]: single }, activeKeyId: LEGACY_KEY_ID };
  }
  throw new Error("DNS_TOKEN_ENC_KEY is not set");
}

// Internal: turn the optional `key` argument into a keyring. A bare base64 key
// string keeps the old call sites (and tests) working: it is treated as the
// active key under id "v1". An explicit Keyring is used as-is.
function asKeyring(key: string | Keyring | undefined): Keyring {
  if (key === undefined) return resolveKeyring();
  if (typeof key === "string") {
    if (!key) throw new Error("DNS_TOKEN_ENC_KEY is not set");
    return { keys: { [LEGACY_KEY_ID]: key }, activeKeyId: LEGACY_KEY_ID };
  }
  return key;
}

/**
 * Encrypt `plaintext` under the active key, returning `<keyId>.<base64>`.
 * Pass a bare base64 key (legacy) to encrypt under id "v1", or a Keyring to
 * encrypt under its active key. Omit to resolve the keyring from the environment.
 */
export async function encryptSecret(
  plaintext: string,
  key?: string | Keyring,
): Promise<string> {
  const ring = asKeyring(key);
  const keyB64 = ring.keys[ring.activeKeyId];
  if (!keyB64) throw new Error(`Active key id "${ring.activeKeyId}" has no key material`);
  const cryptoKey = await importKey(keyB64);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, cryptoKey, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return `${ring.activeKeyId}.${bytesToB64(out)}`;
}

// Split a stored payload into its key id and the base64 iv||ct blob. Payloads
// without a `<keyId>.` prefix are pre-versioning ciphertext and are attributed to
// the legacy key id "v1".
function parsePayload(payload: string): { keyId: string; blobB64: string } {
  const dot = payload.indexOf(".");
  // A base64 body never contains "." so a dot unambiguously marks the prefix.
  if (dot > 0) {
    return { keyId: payload.slice(0, dot), blobB64: payload.slice(dot + 1) };
  }
  return { keyId: LEGACY_KEY_ID, blobB64: payload };
}

/**
 * Decrypt a `<keyId>.<base64>` (or legacy bare-base64) payload, selecting the key
 * by id. FAILS CLOSED: an unknown key id throws a clear error and never returns
 * plaintext. Pass a bare base64 key (legacy) or a Keyring; omit to resolve from
 * the environment.
 */
export async function decryptSecret(
  payload: string,
  key?: string | Keyring,
): Promise<string> {
  const ring = asKeyring(key);
  const { keyId, blobB64 } = parsePayload(payload);
  const keyB64 = ring.keys[keyId];
  if (!keyB64) {
    throw new Error(
      `Cannot decrypt: no key for id "${keyId}". ` +
        "The key may have been rotated out — keep retired keys in DNS_TOKEN_ENC_KEYS until all rows are re-encrypted.",
    );
  }
  const cryptoKey = await importKey(keyB64);
  const bytes = b64ToBytes(blobB64);
  if (bytes.length <= IV_BYTES) throw new Error("Ciphertext is too short to be valid");
  const iv = bytes.subarray(0, IV_BYTES);
  const ct = bytes.subarray(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ct);
  return new TextDecoder().decode(pt);
}

/** The key id a stored payload is encrypted under (for rotation tooling). */
export function keyIdOf(payload: string): string {
  return parsePayload(payload).keyId;
}
