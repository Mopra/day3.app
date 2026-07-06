import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ObjectStore, StoredObject } from "./storage";

// Replaces the Cloudflare R2 `IMPORTS_BUCKET`. CSV uploads land here; the import
// handler reads them back through the ObjectStore seam.
export const IMPORTS_BUCKET = "imports";

// Public bucket for images embedded in campaign emails. Unlike `imports` (private,
// read server-side via the service role), this MUST be public: recipients' mail
// clients fetch the image directly and unauthenticated, and a signed URL would
// expire while the email still sits in inboxes. Object keys are unguessable
// (account id + random id) so "public" means "fetchable with the link", not
// "enumerable".
export const CAMPAIGN_ASSETS_BUCKET = "campaign-assets";

let client: SupabaseClient | undefined;
function getClient(): SupabaseClient {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");
    }
    client = createClient(url, key, { auth: { persistSession: false } });
  }
  return client;
}

// Producer side (API route): store an uploaded CSV at `key`.
export async function putImportObject(
  key: string,
  body: ArrayBuffer,
  contentType = "text/csv",
): Promise<void> {
  const { error } = await getClient()
    .storage.from(IMPORTS_BUCKET)
    .upload(key, body, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload failed: ${error.message}`);
}

// Ensures the public campaign-assets bucket exists. There's no migration mechanism
// for storage buckets, and a forgotten/private bucket would silently ship broken
// images, so we create it idempotently on first use (the service role may create
// buckets). Memoized per process; an "already exists" error is the success path.
let assetsBucketReady = false;
async function ensureCampaignAssetsBucket(sb: SupabaseClient): Promise<void> {
  if (assetsBucketReady) return;
  const { error } = await sb.storage.createBucket(CAMPAIGN_ASSETS_BUCKET, { public: true });
  if (error && !/exist/i.test(error.message)) {
    throw new Error(`Could not create the ${CAMPAIGN_ASSETS_BUCKET} bucket: ${error.message}`);
  }
  assetsBucketReady = true;
}

// Stores a campaign image at `key` in the public bucket and returns its absolute
// public URL — the value embedded as <img src> in the email. `upsert: false` so a
// random key collision surfaces rather than silently overwriting someone's asset.
export async function putCampaignAsset(
  key: string,
  body: ArrayBuffer,
  contentType: string,
): Promise<string> {
  const sb = getClient();
  await ensureCampaignAssetsBucket(sb);
  const { error } = await sb.storage
    .from(CAMPAIGN_ASSETS_BUCKET)
    .upload(key, body, { contentType, upsert: false });
  if (error) throw new Error(`Asset upload failed: ${error.message}`);
  return sb.storage.from(CAMPAIGN_ASSETS_BUCKET).getPublicUrl(key).data.publicUrl;
}

// Deletes every stored object under a single-level key prefix, paging until the
// folder is empty. Both of our buckets store an account's objects directly under
// an account-scoped folder (`imports/<accountId>/<id>.csv`,
// `<accountId>/<id>.png`) with no deeper nesting, so a single-level sweep is
// complete. Throws on a Supabase error — the caller (account purge) treats
// storage teardown as best-effort and swallows it.
async function removePrefix(sb: SupabaseClient, bucket: string, prefix: string): Promise<void> {
  for (;;) {
    const { data, error } = await sb.storage.from(bucket).list(prefix, { limit: 1000 });
    if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
    if (!data || data.length === 0) return;
    const paths = data.map((obj) => `${prefix}/${obj.name}`);
    const { error: rmErr } = await sb.storage.from(bucket).remove(paths);
    if (rmErr) throw new Error(`remove ${bucket}/${prefix}: ${rmErr.message}`);
    // A short final page means the folder is drained; a full page may have more.
    if (data.length < 1000) return;
  }
}

// Erases every stored object an account owns — its uploaded import CSVs (private
// `imports` bucket) and its campaign/form image assets (public `campaign-assets`
// bucket). Both key objects under an account-scoped prefix, so this is two prefix
// sweeps; no per-row enumeration needed. Best-effort account-purge hygiene.
export async function purgeAccountStorage(accountId: string): Promise<void> {
  const sb = getClient();
  await removePrefix(sb, IMPORTS_BUCKET, `imports/${accountId}`);
  await removePrefix(sb, CAMPAIGN_ASSETS_BUCKET, accountId);
}

// Consumer side (worker): the ObjectStore the import handler reads through, plus
// the account-purge teardown hook.
export function createSupabaseObjectStore(): ObjectStore {
  const sb = getClient();
  return {
    async get(key: string): Promise<StoredObject | null> {
      const { data, error } = await sb.storage.from(IMPORTS_BUCKET).download(key);
      if (error || !data) return null;
      return { text: () => data.text() };
    },
    purgeAccount: (accountId: string) => purgeAccountStorage(accountId),
  };
}
