// npm run keys:rotate-dns — re-encrypt every dns_integrations token row that is
// NOT already under the active encryption key, from its old key to the active
// one. Zero-downtime rotation: both old and new keys live in DNS_TOKEN_ENC_KEYS
// while this runs, so reads keep working throughout.
//
// Procedure (see docs/cloudflare-dns-oauth.md "Key rotation"):
//   1. Generate a new key, add it to DNS_TOKEN_ENC_KEYS alongside the old one.
//   2. Point DNS_TOKEN_ENC_ACTIVE_KEY_ID at the new id and deploy.
//   3. Run this script — it rewrites rows still under the old key.
//   4. Once it reports 0 remaining, drop the old key from DNS_TOKEN_ENC_KEYS.
//
// Idempotent: rows already under the active key are skipped, so re-running is
// safe. Decrypt→encrypt happens in-process; plaintext is never persisted.
import postgres from "postgres";
import { decryptSecret, encryptSecret, keyIdOf, resolveKeyring } from "../src/lib/crypto";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const ring = resolveKeyring(); // throws (fails closed) if the keyring is unusable
console.log(`rotating dns_integrations tokens → active key id "${ring.activeKeyId}"`);

const sql = postgres(process.env.DATABASE_URL, { ssl: "require", prepare: false, max: 1 });

type Row = { id: string; access_token_enc: string; refresh_token_enc: string };
const rows = await sql<Row[]>`
  select id, access_token_enc, refresh_token_enc from dns_integrations
`;

let rotated = 0;
let skipped = 0;
for (const row of rows) {
  const needsAccess = keyIdOf(row.access_token_enc) !== ring.activeKeyId;
  const needsRefresh = keyIdOf(row.refresh_token_enc) !== ring.activeKeyId;
  if (!needsAccess && !needsRefresh) {
    skipped++;
    continue;
  }
  // Decrypt with whichever (old) key the row carries, re-encrypt under the active key.
  const access = needsAccess
    ? await encryptSecret(await decryptSecret(row.access_token_enc, ring), ring)
    : row.access_token_enc;
  const refresh = needsRefresh
    ? await encryptSecret(await decryptSecret(row.refresh_token_enc, ring), ring)
    : row.refresh_token_enc;
  await sql`
    update dns_integrations
       set access_token_enc = ${access}, refresh_token_enc = ${refresh}
     where id = ${row.id}
  `;
  rotated++;
}

console.log(`done: rotated=${rotated}, already-current=${skipped}, total=${rows.length}`);
if (rotated > 0) {
  console.log("re-run to confirm rotated=0, then drop retired keys from DNS_TOKEN_ENC_KEYS.");
}
await sql.end();
