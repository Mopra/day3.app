import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { ObjectStore, StoredObject } from "./storage";

// Replaces the Cloudflare R2 `IMPORTS_BUCKET`. CSV uploads land here; the import
// handler reads them back through the ObjectStore seam.
export const IMPORTS_BUCKET = "imports";

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
