import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findAudience } from "@/api/finders";
import { imports } from "@/db/schema";
import { newId, nowIso } from "@/lib/ids";
import { MAX_IMPORT_ROWS, countCsvDataRows, validateCsvUpload } from "@/lib/csv";
import { putImportObject } from "@/lib/supabase-storage";
import { getQueue } from "@/queue/producer";
import { enforceRateLimit } from "@/lib/rate-limit";

// CSV import: store the file in Supabase Storage, create the import row, enqueue
// the process_import job (consumed by the VPS worker).
export const POST = route<{ params: Promise<{ id: string }> }>(async (req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  await enforceRateLimit("import", account.id);
  const audience = await findAudience(db, account.id, id);
  if (!audience) throw new HttpError(404, "Not found");

  const form = await req.formData().catch(() => null);
  const file = form?.get("file");
  if (!(file instanceof File)) {
    throw new HttpError(400, "Upload a CSV file in the 'file' field");
  }
  // Validate filename, content-type, emptiness, and size cap before reading the
  // body or touching storage/the queue.
  const uploadError = validateCsvUpload(file);
  if (uploadError) {
    throw new HttpError(uploadError.status, uploadError.message);
  }

  const bytes = await file.arrayBuffer();
  // Enforce the row cap at the edge: a file over the limit must never become a
  // queued job that only fails inside the worker.
  const rowCount = countCsvDataRows(new TextDecoder().decode(bytes));
  if (rowCount === 0) {
    throw new HttpError(400, "The CSV has no data rows");
  }
  if (rowCount > MAX_IMPORT_ROWS) {
    throw new HttpError(400, `CSV has ${rowCount} rows; the maximum is ${MAX_IMPORT_ROWS}`);
  }

  const importId = newId("imp");
  const key = `imports/${account.id}/${importId}.csv`;
  await putImportObject(key, bytes, "text/csv");

  const now = nowIso();
  await db.insert(imports).values({
    id: importId,
    accountId: account.id,
    audienceId: audience.id,
    r2Key: key,
    filename: file.name || "subscribers.csv",
    status: "pending",
    createdAt: now,
    updatedAt: now,
  });

  await getQueue().send({ type: "process_import", importId, accountId: account.id });

  return json({ importId, maxRows: MAX_IMPORT_ROWS }, 202);
});
