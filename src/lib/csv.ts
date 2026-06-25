import { slugifyFieldKey } from "./form-fields";

export type CsvSubscriberRow = {
  email: string;
  firstName?: string;
  lastName?: string;
  // Any column that isn't email/first/last name becomes a custom attribute,
  // keyed by a slug of its header (e.g. "Phone number" → "phone_number"). These
  // are usable as {{merge_tags}} in campaigns.
  attributes?: Record<string, string>;
};

export type CsvParseResult = {
  rows: CsvSubscriberRow[];
  totalRows: number;
  invalidRows: number;
};

export const MAX_IMPORT_ROWS = 5000;
export const MAX_IMPORT_BYTES = 5 * 1024 * 1024;

// Content types browsers/clients actually send for a .csv: real CSV, generic
// binary, or plain text. We also accept an empty content-type (some clients omit
// it) as long as the filename ends in .csv — see validateCsvUpload.
const ALLOWED_CSV_CONTENT_TYPES = new Set([
  "text/csv",
  "application/csv",
  "application/vnd.ms-excel",
  "text/plain",
  "application/octet-stream",
]);

export type CsvUploadError = { status: 400 | 413; message: string };

// Edge validation for an uploaded CSV File, before it is stored or enqueued.
// Pure (no I/O) so it can be unit-tested and reused. Returns an error object on
// rejection, or null when the upload is acceptable.
export function validateCsvUpload(file: {
  name: string;
  size: number;
  type: string;
}): CsvUploadError | null {
  const name = (file.name ?? "").trim();
  if (!name) {
    return { status: 400, message: "The uploaded file is missing a filename" };
  }
  if (!name.toLowerCase().endsWith(".csv")) {
    return { status: 400, message: "Upload a .csv file" };
  }
  const contentType = (file.type ?? "").split(";")[0].trim().toLowerCase();
  if (contentType && !ALLOWED_CSV_CONTENT_TYPES.has(contentType)) {
    return { status: 400, message: "File must be a CSV (text/csv)" };
  }
  if (file.size <= 0) {
    return { status: 400, message: "The uploaded file is empty" };
  }
  if (file.size > MAX_IMPORT_BYTES) {
    return { status: 413, message: "CSV too large (max 5 MB)" };
  }
  return null;
}

// Number of non-blank data rows (excludes the header). Used to enforce
// MAX_IMPORT_ROWS at the edge before enqueueing the import job, so an oversized
// file never becomes a job that only fails inside the worker.
export function countCsvDataRows(content: string): number {
  const lines = parseCsvLines(content);
  return lines.length === 0 ? 0 : lines.length - 1;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// The single canonical form for an email everywhere it is stored or compared:
// trimmed + lowercased. Storing the canonical form keeps the (audience_id, email)
// / (campaign_id, email) unique indexes case-insensitive in practice, and keeps
// suppression lookups and dedupe filters from mixing raw and lowercased values.
export function canonicalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isValidEmail(value: string): boolean {
  return value.length <= 320 && EMAIL_RE.test(value);
}

// Minimal RFC-4180-ish parser: handles quoted fields, escaped quotes, CRLF.
function parseCsvLines(content: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && content[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim().length > 0));
}

const HEADER_ALIASES: Record<string, "email" | "firstName" | "lastName"> = {
  email: "email",
  "e-mail": "email",
  email_address: "email",
  first_name: "firstName",
  firstname: "firstName",
  "first name": "firstName",
  last_name: "lastName",
  lastname: "lastName",
  "last name": "lastName",
};

// Columns we emit on export for readability (see toSubscriberCsv) but that must
// NOT round-trip back in as custom attributes when an exported file is edited and
// re-imported. Matched against the lowercased, trimmed header.
const EXPORT_ONLY_HEADERS = new Set(["status"]);

// What a header column maps to: a known subscriber column, a custom attribute
// (keyed by a slug of the header), or nothing (blank/export-only header — skipped).
type ColumnTarget =
  | { kind: "email" | "firstName" | "lastName" }
  | { kind: "attribute"; key: string }
  | null;

const MAX_ATTR_VALUE_LEN = 500;

export function parseSubscriberCsv(content: string): CsvParseResult {
  const lines = parseCsvLines(content);
  if (lines.length === 0) return { rows: [], totalRows: 0, invalidRows: 0 };

  const header = lines[0].map((h) => h.trim().toLowerCase());
  const columns: ColumnTarget[] = header.map((h) => {
    const alias = HEADER_ALIASES[h];
    if (alias) return { kind: alias };
    if (EXPORT_ONLY_HEADERS.has(h)) return null;
    const key = slugifyFieldKey(h);
    // Unrecognized, non-empty headers become custom attributes. A header that
    // slugs to nothing (e.g. all punctuation) is skipped.
    return key ? { kind: "attribute", key } : null;
  });
  if (!columns.some((c) => c?.kind === "email")) {
    throw new Error('CSV must include an "email" column');
  }

  const dataLines = lines.slice(1);
  const rows: CsvSubscriberRow[] = [];
  let invalidRows = 0;

  for (const line of dataLines) {
    const record: Partial<CsvSubscriberRow> = {};
    const attributes: Record<string, string> = {};
    columns.forEach((col, i) => {
      if (!col) return;
      const value = (line[i] ?? "").trim();
      if (!value) return;
      if (col.kind === "email") record.email = canonicalizeEmail(value);
      else if (col.kind === "firstName") record.firstName = value;
      else if (col.kind === "lastName") record.lastName = value;
      else if (col.kind === "attribute") attributes[col.key] = value.slice(0, MAX_ATTR_VALUE_LEN);
    });
    if (!record.email || !isValidEmail(record.email)) {
      invalidRows++;
      continue;
    }
    if (Object.keys(attributes).length > 0) record.attributes = attributes;
    rows.push(record as CsvSubscriberRow);
  }

  return { rows, totalRows: dataLines.length, invalidRows };
}

// Quote a CSV field when it contains a comma, double-quote, or newline; double any
// internal quotes (RFC-4180). Safe to pass any value — null/undefined become "".
function csvField(value: string | null | undefined): string {
  const s = value == null ? "" : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export type SubscriberCsvRow = {
  email: string;
  firstName?: string | null;
  lastName?: string | null;
  status?: string | null;
  attributes?: Record<string, string> | null;
};

// Serialize subscribers back into the same CSV shape parseSubscriberCsv reads, so
// an export can be opened, edited, and re-imported cleanly. Columns are: email,
// first_name, last_name, status, then the sorted union of every custom attribute
// key seen across the rows. `status` is an export-only column (ignored on import).
export function toSubscriberCsv(rows: SubscriberCsvRow[]): string {
  const attrKeys = new Set<string>();
  for (const r of rows) {
    if (r.attributes) for (const k of Object.keys(r.attributes)) attrKeys.add(k);
  }
  const sortedAttrKeys = [...attrKeys].sort();
  const header = ["email", "first_name", "last_name", "status", ...sortedAttrKeys];
  const lines = [header.map(csvField).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.email,
        r.firstName,
        r.lastName,
        r.status,
        ...sortedAttrKeys.map((k) => r.attributes?.[k]),
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// Sample CSV handed to users from the import UI so they can see the expected
// shape. Only `email` is required; first_name/last_name are optional and any
// further columns become custom {{merge_tag}} attributes.
export const SUBSCRIBER_CSV_TEMPLATE =
  "email,first_name,last_name\r\n" +
  "jane@example.com,Jane,Doe\r\n" +
  "john@example.com,John,Smith\r\n";
