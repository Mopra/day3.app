import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import { imports, subscribers } from "../../db/schema";
import { newId, nowIso } from "../../lib/ids";
import { logJob } from "../../lib/job-log";
import { canonicalizeEmail, MAX_IMPORT_ROWS, parseSubscriberCsv } from "../../lib/csv";
import { getSuppressedEmails } from "../../services/suppression";
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

    const suppressed = await getSuppressedEmails(
      db,
      importRow.accountId,
      parsed.rows.map((r) => r.email),
    );

    // parseSubscriberCsv already canonicalizes r.email; canonicalize here too so
    // the suppression filter never compares a raw against a canonical value.
    const candidates = parsed.rows.filter((r) => !suppressed.has(canonicalizeEmail(r.email)));

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
            status: "subscribed" as const,
            source: "import",
            importedAt: now,
            createdAt: now,
            updatedAt: now,
          })),
        )
        .onConflictDoNothing()
        .returning({ id: subscribers.id });
      imported += result.length;
    }

    await db
      .update(imports)
      .set({
        status: "completed",
        totalRows: parsed.totalRows,
        importedRows: imported,
        skippedRows: parsed.totalRows - imported,
        error: null,
        updatedAt: nowIso(),
      })
      .where(eq(imports.id, importRow.id));

    await logJob(db, {
      jobType: "process_import",
      entityType: "import",
      entityId: importRow.id,
      status: "completed",
      payload: { totalRows: parsed.totalRows, imported, invalid: parsed.invalidRows },
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
