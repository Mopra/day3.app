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

// Consumer side (worker): the ObjectStore the import handler reads through.
export function createSupabaseObjectStore(): ObjectStore {
  const sb = getClient();
  return {
    async get(key: string): Promise<StoredObject | null> {
      const { data, error } = await sb.storage.from(IMPORTS_BUCKET).download(key);
      if (error || !data) return null;
      return { text: () => data.text() };
    },
  };
}
