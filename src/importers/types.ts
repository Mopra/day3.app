import type { ImportableRow } from "../services/import-rows";
import type { ProviderId } from "./catalog";

// The contract every "Import from another provider" importer implements. The
// import job (src/queue/handlers/process-provider-import.ts) owns everything that
// is the same for all of them: the encrypted key, paging, resume, suppression,
// dedupe, the plan's subscriber cap, progress and counts. A provider only knows
// its own API: which lists exist, how to page through one, and what its statuses
// mean.

export type ProviderContext = {
  apiKey: string;
  // Seams for tests: a mock server's origin in place of the provider's real API
  // host, and a fake clock for the 429 backoff. Never set from user input.
  baseUrl?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  // How many times one request is tried on a 429/5xx/network error. The worker
  // waits as long as the provider asks; the web tier (a user waiting on a
  // dialog) passes a small number so a rate-limited key fails fast and clearly.
  maxAttempts?: number;
  maxWaitMs?: number;
};

export type ImportSourceSummary = {
  id: string;
  name: string;
  // Contacts that would be mailed after the import, where the provider says.
  // Used for the free-plan cap check before the job starts.
  subscribedCount: number | null;
  // Every contact the import will read (all statuses), for the progress bar.
  totalCount: number | null;
};

// What one provider status means in Day3. `skip` is a valid address we decline to
// import (bounced, complained, never confirmed): it belongs on the suppression
// list, not in an audience. Unknown statuses must map to `skip`, never to
// `subscribed`: unlike a free-form CSV column, an API status is structured, so an
// unrecognized value is a new state we have not reasoned about.
export type MappedStatus = "subscribed" | "unsubscribed" | "skip";

export type ProviderRecord =
  | { kind: "row"; row: ImportableRow }
  | { kind: "skip"; reason: "invalid" | "status" };

export type ProviderPage = {
  records: ProviderRecord[];
  // Opaque; null when this was the last page. Stored on the import row after the
  // page commits, so a resumed job continues from the next page.
  nextCursor: string | null;
  // Every record the import will read, when the API reports it.
  total?: number | null;
};

export interface ImportProvider {
  id: ProviderId;
  listSources(ctx: ProviderContext): Promise<ImportSourceSummary[]>;
  fetchPage(ctx: ProviderContext, sourceId: string, cursor: string | null): Promise<ProviderPage>;
  mapStatus(status: string): MappedStatus;
}
