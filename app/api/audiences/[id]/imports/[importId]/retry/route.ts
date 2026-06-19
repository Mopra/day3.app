import { and, eq } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { imports } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { MAX_IMPORT_ROWS, countCsvDataRows, validateCsvUpload } from "@/lib/csv";
import { putImportObject } from "@/lib/supabase-storage";
import { getQueue } from "@/queue/producer";
import { enforceRateLimit } from "@/lib/rate-limit";

// Retry a failed import: the user re-uploads a corrected CSV, which overwrites
// the stored object for the SAME import row, resets it to `pending`, and
// re-enqueues process_import. Re-running is dedup-safe — subscribers are inserted
// with onConflictDoNothing on (audience, email), so rows that imported on an
// earlier (partial) attempt are never duplicated.
export const POST = route<{ params: Promise<{ id: string; importId: string }> }>(
  async (req, { params }) => {
    const { id, importId } = await params;
    const { db, account } = await requireAccount();
    await enforceRateLimit("import", account.id);
    const audience = await findAudience(db, account.id, id);
    if (!audience) throw new HttpError(404, "Not found");

    const importRow = await db.query.imports.findFirst({
      where: and(eq(imports.id, importId), eq(imports.accountId, account.id)),
    });
    if (!importRow || importRow.audienceId !== audience.id) {
      throw new HttpError(404, "Not found");
    }
    // Only a failed import is retryable; pending/processing are in-flight and a
    // completed import is final (re-importing would be a fresh upload).
    if (importRow.status !== "failed") {
      throw new HttpError(409, `Only failed imports can be retried (status is "${importRow.status}")`);
    }

    const form = await req.formData().catch(() => null);
    const file = form?.get("file");
    if (!(file instanceof File)) {
      throw new HttpError(400, "Upload a corrected CSV file in the 'file' field");
    }
    const uploadError = validateCsvUpload(file);
    if (uploadError) {
      throw new HttpError(uploadError.status, uploadError.message);
    }

    const bytes = await file.arrayBuffer();
    const rowCount = countCsvDataRows(new TextDecoder().decode(bytes));
    if (rowCount === 0) {
      throw new HttpError(400, "The CSV has no data rows");
    }
    if (rowCount > MAX_IMPORT_ROWS) {
      throw new HttpError(400, `CSV has ${rowCount} rows; the maximum is ${MAX_IMPORT_ROWS}`);
    }

    // Overwrite the stored object in place (same r2Key) with the corrected file.
    await putImportObject(importRow.r2Key, bytes, "text/csv");

    await db
      .update(imports)
      .set({
        status: "pending",
        filename: file.name || importRow.filename,
        totalRows: 0,
        importedRows: 0,
        skippedRows: 0,
        error: null,
        updatedAt: nowIso(),
      })
      .where(eq(imports.id, importRow.id));

    await getQueue().send({
      type: "process_import",
      importId: importRow.id,
      accountId: account.id,
    });

    return json({ importId: importRow.id, maxRows: MAX_IMPORT_ROWS }, 202);
  },
);
