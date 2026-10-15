import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accounts, imports, type Import } from "../../db/schema";
import { nowIso } from "../../lib/ids";
import { logJob } from "../../lib/job-log";
import { decryptSecret } from "../../lib/crypto";
import { maxSubscribersForPlan } from "../../lib/plans-catalog";
import { registerAudienceFields } from "../../services/audience-fields";
import { countAccountSubscribers } from "../../services/subscriber-limit";
import { enrollAudienceJoin } from "../../services/automation-enroll";
import { importRowsChunk, type ImportableRow } from "../../services/import-rows";
import { getImportProvider, ImportProviderError, isProviderId } from "../../importers";
import type { ProviderContext } from "../../importers/types";

// Test seams only (a mock server origin, a fake clock). Production passes none.
export type ProviderImportDeps = Omit<ProviderContext, "apiKey">;

/**
 * Run an "Import from another provider" job: page through the provider's API
 * and put every contact through the same rules a CSV import uses (suppression,
 * dedupe, free-plan cap, opt-outs kept). Each page commits its rows, its counts
 * and the next cursor together, so a job that crashes or is redeployed resumes
 * from the page after the last one it finished, with the counts it had.
 *
 * The API key lives on the row encrypted, only while the job runs: both terminal
 * writes below set it to NULL. Errors are recorded on the row and swallowed, like
 * the CSV path: a queue retry must not restart a failed import.
 */
export async function processProviderImport(
  db: Db,
  importRow: Import,
  deps: ProviderImportDeps = {},
): Promise<void> {
  const counts = {
    total: importRow.totalRows,
    imported: importRow.importedRows,
    unsubscribed: importRow.unsubscribedRows,
    invalid: importRow.invalidRows,
    suppressed: importRow.suppressedRows,
    duplicate: importRow.duplicateRows,
    overCap: importRow.overCapRows,
    statusSkipped: importRow.statusSkippedRows,
  };
  // On a resume `total` already holds the provider's own count; `read` restarts
  // from what the committed counts account for.
  let read =
    counts.imported +
    counts.invalid +
    counts.suppressed +
    counts.duplicate +
    counts.overCap +
    counts.statusSkipped;
  const skipped = () =>
    counts.invalid + counts.suppressed + counts.duplicate + counts.overCap + counts.statusSkipped;

  try {
    if (!isProviderId(importRow.source)) {
      throw new Error(`Unknown import source "${importRow.source}"`);
    }
    if (!importRow.sourceCredential || !importRow.sourceRef) {
      throw new Error(
        "The API key for this import is no longer stored. Start the import again from the audience page; contacts already imported are kept.",
      );
    }
    const provider = getImportProvider(importRow.source);
    const ctx: ProviderContext = {
      ...deps,
      apiKey: await decryptSecret(importRow.sourceCredential),
    };

    // Free-plan cap, computed fresh (a resumed job's earlier pages are already in
    // the count). Paid plans are unlimited (null).
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.id, importRow.accountId),
    });
    const cap = account ? maxSubscribersForPlan(account.plan) : null;
    let headroom =
      cap === null ? null : Math.max(0, cap - (await countAccountSubscribers(db, importRow.accountId)));

    const target = { accountId: importRow.accountId, audienceId: importRow.audienceId };
    const knownFields = new Set<string>();
    let cursor = importRow.sourceCursor;

    for (;;) {
      const page = await provider.fetchPage(ctx, importRow.sourceRef, cursor);
      const rows: ImportableRow[] = [];
      for (const rec of page.records) {
        if (rec.kind === "row") rows.push(rec.row);
        else if (rec.reason === "invalid") counts.invalid++;
        else counts.statusSkipped++;
      }
      read += page.records.length;

      const newKeys = new Set<string>();
      for (const row of rows) {
        for (const key of Object.keys(row.attributes ?? {})) {
          if (!knownFields.has(key)) newKeys.add(key);
        }
      }
      if (newKeys.size > 0) {
        await registerAudienceFields(
          db,
          importRow.accountId,
          importRow.audienceId,
          [...newKeys].map((key) => ({ key })),
        );
        for (const k of newKeys) knownFields.add(k);
      }

      const res = await importRowsChunk(db, target, rows, { headroom, now: nowIso() });
      if (headroom !== null) headroom = Math.max(0, headroom - res.attempted);
      counts.imported += res.imported;
      counts.unsubscribed += res.unsubscribed;
      counts.suppressed += res.suppressed;
      counts.duplicate += res.duplicates;
      counts.overCap += res.overCap;
      counts.total = Math.max(counts.total, page.total ?? 0, read);

      cursor = page.nextCursor;
      await db
        .update(imports)
        .set({
          totalRows: counts.total,
          importedRows: counts.imported,
          unsubscribedRows: counts.unsubscribed,
          skippedRows: skipped(),
          invalidRows: counts.invalid,
          suppressedRows: counts.suppressed,
          duplicateRows: counts.duplicate,
          overCapRows: counts.overCap,
          statusSkippedRows: counts.statusSkipped,
          sourceCursor: cursor,
          updatedAt: nowIso(),
        })
        .where(eq(imports.id, importRow.id));

      // Never throws; enqueues through the worker's ambient queue. Per page so a
      // resumed job does not lose the joins of the pages before the crash.
      await enrollAudienceJoin(db, null, { ...target, subscriberIds: res.joinedIds });

      if (!cursor) break;
    }
    // The provider's own total can include contacts its listing never returned
    // (deleted mid-import); report what was actually read.
    counts.total = read;

    await db
      .update(imports)
      .set({
        status: "completed",
        totalRows: counts.total,
        skippedRows: skipped(),
        sourceCredential: null,
        sourceCursor: null,
        error: null,
        updatedAt: nowIso(),
      })
      .where(eq(imports.id, importRow.id));

    await logJob(db, {
      jobType: "process_import",
      entityType: "import",
      entityId: importRow.id,
      status: "completed",
      payload: {
        source: importRow.source,
        totalRows: counts.total,
        imported: counts.imported,
        subscribed: counts.imported - counts.unsubscribed,
        unsubscribed: counts.unsubscribed,
        skipped: skipped(),
        invalid: counts.invalid,
        suppressed: counts.suppressed,
        duplicate: counts.duplicate,
        overCap: counts.overCap,
        statusSkipped: counts.statusSkipped,
      },
    });
  } catch (err) {
    const errorMessage =
      err instanceof ImportProviderError
        ? err.message
        : err instanceof Error
          ? err.message
          : String(err);
    await db
      .update(imports)
      .set({
        status: "failed",
        error: errorMessage,
        sourceCredential: null,
        updatedAt: nowIso(),
      })
      .where(eq(imports.id, importRow.id));
    await logJob(db, {
      jobType: "process_import",
      entityType: "import",
      entityId: importRow.id,
      status: "failed",
      error: errorMessage,
      payload: {
        source: importRow.source,
        code: err instanceof ImportProviderError ? err.code : "internal",
        imported: counts.imported,
        unsubscribed: counts.unsubscribed,
        skipped: skipped(),
      },
    });
  }
}
