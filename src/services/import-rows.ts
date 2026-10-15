import type { Db } from "../db/client";
import { subscribers } from "../db/schema";
import { newId } from "../lib/ids";
import { canonicalizeEmail, type CsvSubscriberRow } from "../lib/csv";
import { getSuppressedEmails } from "./suppression";

// One contact on its way into an audience, from any import path: a CSV row, or a
// record a provider importer (src/importers) mapped from another platform's API.
// Only `subscribed` / `unsubscribed` can be asserted, the same writable-status
// rule the public API and the CSV parser enforce.
export type ImportableRow = CsvSubscriberRow & {
  // When the contact joined at the old provider. Absent means "now".
  createdAt?: string;
};

export type ImportChunkResult = {
  // Rows the free-tier cap let through to the insert (inserted or duplicate).
  attempted: number;
  imported: number;
  // Of `imported`, how many landed as `unsubscribed`.
  unsubscribed: number;
  suppressed: number;
  duplicates: number;
  overCap: number;
  // Newly inserted `subscribed` rows: the audience-join trigger fires for these.
  joinedIds: string[];
};

// Postgres allows up to 65535 bound params per statement; chunk into
// comfortably-sized multi-row inserts.
export const IMPORT_INSERT_CHUNK = 500;

/**
 * Insert one batch of rows into an audience with every import rule applied:
 * suppressed addresses are dropped, the free-tier cap (`headroom`, null when the
 * plan is unlimited) truncates, and an address already in the audience is a
 * duplicate (onConflictDoNothing), never an update. That last rule is what makes
 * every import safe to resume or re-run: nobody who left is re-subscribed and
 * nobody is doubled. The caller tracks headroom across batches by subtracting
 * `attempted`.
 */
export async function importRowsChunk(
  db: Db,
  target: { accountId: string; audienceId: string },
  rows: ImportableRow[],
  opts: { headroom: number | null; now: string },
): Promise<ImportChunkResult> {
  const result: ImportChunkResult = {
    attempted: 0,
    imported: 0,
    unsubscribed: 0,
    suppressed: 0,
    duplicates: 0,
    overCap: 0,
    joinedIds: [],
  };
  if (rows.length === 0) return result;

  const suppressed = await getSuppressedEmails(
    db,
    target.accountId,
    rows.map((r) => r.email),
  );
  // Rows arrive canonical from both parsers; canonicalize here too so the filter
  // never compares a raw against a canonical value.
  let candidates = rows.filter((r) => !suppressed.has(canonicalizeEmail(r.email)));
  result.suppressed = rows.length - candidates.length;

  if (opts.headroom !== null && candidates.length > opts.headroom) {
    const headroom = Math.max(0, opts.headroom);
    result.overCap = candidates.length - headroom;
    candidates = candidates.slice(0, headroom);
  }
  result.attempted = candidates.length;

  const { now } = opts;
  for (let i = 0; i < candidates.length; i += IMPORT_INSERT_CHUNK) {
    const chunk = candidates.slice(i, i + IMPORT_INSERT_CHUNK);
    const inserted = await db
      .insert(subscribers)
      .values(
        chunk.map((row) => ({
          id: newId("sub"),
          accountId: target.accountId,
          audienceId: target.audienceId,
          email: canonicalizeEmail(row.email),
          firstName: row.firstName ?? null,
          lastName: row.lastName ?? null,
          attributes: row.attributes ?? null,
          // A status carries opt-outs over from another platform, so a migration
          // never re-subscribes someone who had left. Absent means `subscribed`.
          // Bounce/complaint/unconfirmed never reach here: the parsers drop them.
          status: row.status ?? ("subscribed" as const),
          // Keep the original opt-out date when the source had one, so "when did
          // they leave?" survives the move.
          unsubscribedAt: row.status === "unsubscribed" ? (row.unsubscribedAt ?? now) : null,
          source: "import",
          importedAt: now,
          createdAt: row.createdAt ?? now,
          updatedAt: now,
        })),
      )
      .onConflictDoNothing()
      .returning({ id: subscribers.id, status: subscribers.status });
    result.imported += inserted.length;
    for (const r of inserted) {
      if (r.status === "subscribed") result.joinedIds.push(r.id);
      else if (r.status === "unsubscribed") result.unsubscribed++;
    }
  }
  result.duplicates = candidates.length - result.imported;
  return result;
}
