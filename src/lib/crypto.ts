// AES-256-GCM encryption for secrets at rest — specifically the Cloudflare OAuth
// access/refresh tokens, which are credentials to a customer's DNS and must never
// be stored in plaintext. Ciphertext layout: base64( iv[12] || ciphertext+tag ).
// The key is 32 raw bytes supplied base64-encoded in DNS_TOKEN_ENC_KEY.

const IV_BYTES = 12; // standard GCM nonce length

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

function requireKey(keyB64: string | undefined): string {
  if (!keyB64) throw new Error("DNS_TOKEN_ENC_KEY is not set");
  return keyB64;
}

async function importKey(keyB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(keyB64);
  if (raw.length !== 32) {
    throw new Error("DNS_TOKEN_ENC_KEY must decode to 32 bytes (a base64-encoded AES-256 key)");
  }
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptSecret(
  plaintext: string,
  keyB64: string | undefined = process.env.DNS_TOKEN_ENC_KEY,
): Promise<string> {
  const key = await importKey(requireKey(keyB64));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext)),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return bytesToB64(out);
}

export async function decryptSecret(
  payloadB64: string,
  keyB64: string | undefined = process.env.DNS_TOKEN_ENC_KEY,
): Promise<string> {
  const key = await importKey(requireKey(keyB64));
  const bytes = b64ToBytes(payloadB64);
  if (bytes.length <= IV_BYTES) throw new Error("Ciphertext is too short to be valid");
  const iv = bytes.subarray(0, IV_BYTES);
  const ct = bytes.subarray(IV_BYTES);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct);
  return new TextDecoder().decode(pt);
}
