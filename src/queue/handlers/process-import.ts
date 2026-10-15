import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accounts, imports } from "../../db/schema";
import { nowIso } from "../../lib/ids";
import { logJob } from "../../lib/job-log";
import { MAX_IMPORT_ROWS, parseSubscriberCsv } from "../../lib/csv";
import { maxSubscribersForPlan } from "../../lib/plans-catalog";
import { registerAudienceFields } from "../../services/audience-fields";
import { countAccountSubscribers } from "../../services/subscriber-limit";
import { enrollAudienceJoin } from "../../services/automation-enroll";
import { IMPORT_INSERT_CHUNK, importRowsChunk } from "../../services/import-rows";
import type { ObjectStore } from "../../lib/storage";
import { processProviderImport, type ProviderImportDeps } from "./process-provider-import";

export async function processImport(
  message: { importId: string; accountId: string },
  db: Db,
  store: ObjectStore,
  providerDeps?: ProviderImportDeps,
): Promise<void> {
  const importRow = await db.query.imports.findFirst({
    where: and(eq(imports.id, message.importId), eq(imports.accountId, message.accountId)),
  });

  if (!importRow) {
    await logJob(db, {
      jobType: "process_import",
      entityType: "import",
      entityId: message.importId,
      status: "skipped",
      error: "import not found",
    });
    return;
  }

  // Idempotency: completed/failed imports are final; a retried message must
  // not re-import. "processing" is resumed (a crashed attempt) — inserts are
  // dedup-safe via onConflictDoNothing.
  if (importRow.status === "completed" || importRow.status === "failed") {
    await logJob(db, {
      jobType: "process_import",
      entityType: "import",
      entityId: importRow.id,
      status: "skipped",
      error: `import already ${importRow.status}`,
    });
    return;
  }

  await db
    .update(imports)
    .set({ status: "processing", updatedAt: nowIso() })
    .where(eq(imports.id, importRow.id));

  // "Import from another provider" (beehiiv, Kit, ...): same job, same rules,
  // rows paged from the provider's API instead of read from a stored file.
  if (importRow.source !== "csv") {
    return processProviderImport(db, importRow, providerDeps);
  }

  try {
    const object = await store.get(importRow.r2Key);
    if (!object) throw new Error(`CSV not found in storage at ${importRow.r2Key}`);
    const content = await object.text();

    const parsed = parseSubscriberCsv(content);
    if (parsed.totalRows > MAX_IMPORT_ROWS) {
      throw new Error(`CSV has ${parsed.totalRows} rows; the maximum is ${MAX_IMPORT_ROWS}`);
    }

    // Record the denominator up front so the UI can show honest progress
    // ("N of M") while the chunks run, instead of a fake fixed bar.
    await db
      .update(imports)
      .set({ totalRows: parsed.totalRows, updatedAt: nowIso() })
      .where(eq(imports.id, importRow.id));

    // Catalogue any new custom columns in the audience's field registry so they
    // show up as merge tags / table columns immediately — even if every row
    // below turns out to be a duplicate. Idempotent, so a resumed import is fine.
    const attrKeys = new Set<string>();
    for (const row of parsed.rows) {
      for (const key of Object.keys(row.attributes ?? {})) attrKeys.add(key);
    }
    if (attrKeys.size > 0) {
      await registerAudienceFields(
        db,
        importRow.accountId,
        importRow.audienceId,
        [...attrKeys].map((key) => ({ key })),
      );
    }

    // Free-tier subscriber-cap backstop. The upload route already rejects an
    // import that wouldn't fit, but subscribers can arrive via public forms
    // between upload and processing, so cap inserts to the remaining headroom
    // here too. Paid tiers are unlimited (cap = null).
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.id, importRow.accountId),
    });
    const cap = account ? maxSubscribersForPlan(account.plan) : null;
    let headroom =
      cap === null ? null : Math.max(0, cap - (await countAccountSubscribers(db, importRow.accountId)));

    const now = nowIso();
    let imported = 0;
    let unsubscribed = 0;
    let suppressedCount = 0;
    let overCapCount = 0;
    let duplicateCount = 0;
    // Rows that landed as `subscribed`: the audience-join trigger fires for
    // these once the import has committed (not for opt-outs carried over).
    const joinedIds: string[] = [];
    const target = { accountId: importRow.accountId, audienceId: importRow.audienceId };
    for (let i = 0; i < parsed.rows.length; i += IMPORT_INSERT_CHUNK) {
      const res = await importRowsChunk(db, target, parsed.rows.slice(i, i + IMPORT_INSERT_CHUNK), {
        headroom,
        now,
      });
      if (headroom !== null) headroom = Math.max(0, headroom - res.attempted);
      imported += res.imported;
      unsubscribed += res.unsubscribed;
      suppressedCount += res.suppressed;
      overCapCount += res.overCap;
      duplicateCount += res.duplicates;
      joinedIds.push(...res.joinedIds);
      // Progressive count so a large import shows real movement, not a hang.
      await db
        .update(imports)
        .set({ importedRows: imported, updatedAt: nowIso() })
        .where(eq(imports.id, importRow.id));
    }

    // Duplicates = rows onConflictDoNothing skipped (already in this audience).
    // The five reasons sum to skippedRows.
    const skipped =
      suppressedCount +
      parsed.invalidRows +
      parsed.statusSkippedRows +
      overCapCount +
      duplicateCount;

    await db
      .update(imports)
      .set({
        status: "completed",
        totalRows: parsed.totalRows,
        importedRows: imported,
        unsubscribedRows: unsubscribed,
        skippedRows: skipped,
        invalidRows: parsed.invalidRows,
        suppressedRows: suppressedCount,
        duplicateRows: duplicateCount,
        overCapRows: overCapCount,
        statusSkippedRows: parsed.statusSkippedRows,
        error: null,
        updatedAt: nowIso(),
      })
      .where(eq(imports.id, importRow.id));

    // After the import is recorded complete, so a trigger hiccup can never
    // fail the import. The handler has no queue of its own; the hook enqueues
    // through the worker's ambient queue. Never throws.
    await enrollAudienceJoin(db, null, {
      accountId: importRow.accountId,
      audienceId: importRow.audienceId,
      subscriberIds: joinedIds,
    });

    await logJob(db, {
      jobType: "process_import",
      entityType: "import",
      entityId: importRow.id,
      status: "completed",
      payload: {
        totalRows: parsed.totalRows,
        imported,
        unsubscribed,
        invalid: parsed.invalidRows,
        suppressed: suppressedCount,
        duplicate: duplicateCount,
        overCap: overCapCount,
        statusSkipped: parsed.statusSkippedRows,
      },
    });
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    await db
      .update(imports)
      .set({ status: "failed", error: errorMessage, updatedAt: nowIso() })
      .where(eq(imports.id, importRow.id));
    await logJob(db, {
      jobType: "process_import",
      entityType: "import",
      entityId: importRow.id,
      status: "failed",
      error: errorMessage,
    });
    // Final state recorded in Postgres — do not rethrow, a queue retry must not
    // restart a failed import.
  }
}
