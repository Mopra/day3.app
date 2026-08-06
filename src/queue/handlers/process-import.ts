import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { accounts, imports, subscribers } from "../../db/schema";
import { newId, nowIso } from "../../lib/ids";
import { logJob } from "../../lib/job-log";
import { canonicalizeEmail, MAX_IMPORT_ROWS, parseSubscriberCsv } from "../../lib/csv";
import { maxSubscribersForPlan } from "../../lib/plans-catalog";
import { getSuppressedEmails } from "../../services/suppression";
import { registerAudienceFields } from "../../services/audience-fields";
import { countAccountSubscribers } from "../../services/subscriber-limit";
import type { ObjectStore } from "../../lib/storage";

// Postgres allows up to 65535 bound params per statement; chunk into
// comfortably-sized multi-row inserts.
const INSERT_CHUNK = 500;

export async function processImport(
  message: { importId: string; accountId: string },
  db: Db,
  store: ObjectStore,
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

    const suppressed = await getSuppressedEmails(
      db,
      importRow.accountId,
      parsed.rows.map((r) => r.email),
    );

    // parseSubscriberCsv already canonicalizes r.email; canonicalize here too so
    // the suppression filter never compares a raw against a canonical value.
    const validCount = parsed.rows.length;
    const afterSuppression = parsed.rows.filter(
      (r) => !suppressed.has(canonicalizeEmail(r.email)),
    );
    const suppressedCount = validCount - afterSuppression.length;

    // Free-tier subscriber-cap backstop. The upload route already rejects an
    // import that wouldn't fit, but subscribers can arrive via public forms
    // between upload and processing — so cap inserts to the remaining headroom
    // here too. Paid tiers are unlimited (cap = null).
    const account = await db.query.accounts.findFirst({
      where: eq(accounts.id, importRow.accountId),
    });
    const cap = account ? maxSubscribersForPlan(account.plan) : null;
    let candidates = afterSuppression;
    let overCapCount = 0;
    if (cap !== null) {
      const current = await countAccountSubscribers(db, importRow.accountId);
      const headroom = Math.max(0, cap - current);
      if (candidates.length > headroom) {
        overCapCount = candidates.length - headroom;
        candidates = candidates.slice(0, headroom);
      }
    }

    const now = nowIso();
    let imported = 0;
    for (let i = 0; i < candidates.length; i += INSERT_CHUNK) {
      const chunk = candidates.slice(i, i + INSERT_CHUNK);
      const result = await db
        .insert(subscribers)
        .values(
          chunk.map((row) => ({
            id: newId("sub"),
            accountId: importRow.accountId,
            audienceId: importRow.audienceId,
            email: canonicalizeEmail(row.email),
            firstName: row.firstName ?? null,
            lastName: row.lastName ?? null,
            attributes: row.attributes ?? null,
            // A `status` column carries opt-outs over from another platform, so a
            // migration never re-subscribes someone who had left. Absent → the
            // historical default, `subscribed`. Bounce/complaint statuses never
            // reach here: parseSubscriberCsv drops those rows (statusSkippedRows).
            status: row.status ?? ("subscribed" as const),
            // Preserve the original opt-out date when the file carried one, so
            // "when did they leave?" survives the move.
            unsubscribedAt:
              row.status === "unsubscribed" ? (row.unsubscribedAt ?? now) : null,
            source: "import",
            importedAt: now,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: subscribers.id });
      imported += result.length;
      // Progressive count so a large import shows real movement, not a hang.
      await db
        .update(imports)
        .set({ importedRows: imported, updatedAt: nowIso() })
        .where(eq(imports.id, importRow.id));
    }

    // Duplicates = rows we tried to insert that onConflictDoNothing skipped
    // (already in this audience). The five reasons sum to skippedRows.
    const duplicateCount = candidates.length - imported;
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

    await logJob(db, {
      jobType: "process_import",
      entityType: "import",
      entityId: importRow.id,
      status: "completed",
      payload: {
        totalRows: parsed.totalRows,
        imported,
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
