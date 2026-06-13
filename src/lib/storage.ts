// Port seam for blob storage of uploaded CSV imports. Cloudflare R2 is replaced
// by Supabase Storage (Phase 2/4). The import handler only needs to read an
// object's contents as text, so it depends on this minimal interface rather than
// any concrete client — keeping the handler transport-agnostic and testable.
export interface StoredObject {
  text(): Promise<string>;
}

export interface ObjectStore {
  get(key: string): Promise<StoredObject | null>;
}
