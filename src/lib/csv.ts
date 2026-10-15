import { slugifyFieldKey } from "./form-fields";

// The only two statuses a CSV may write. Everything else in SUBSCRIBER_STATUSES
// (`bounced`, `complained`, `suppressed`, `pending`) is owned by the delivery
// pipeline or the double-opt-in flow — a file cannot assert our own send history
// — which mirrors the public API's writable-status rule exactly.
export type CsvSubscriberStatus = "subscribed" | "unsubscribed";

export type CsvSubscriberRow = {
  email: string;
  firstName?: string;
  lastName?: string;
  // From an optional `status` column. Absent (or an unrecognized value) means
  // `subscribed` — see STATUS_VALUES.
  status?: CsvSubscriberStatus;
  // From an optional `unsubscribed_at` column; only meaningful when status is
  // `unsubscribed`. Lets a migration keep the original opt-out date instead of
  // stamping everyone with the import time.
  unsubscribedAt?: string;
  // When the contact joined at the old provider (a `created_at`-style column),
  // so a migration keeps the real signup date. Absent means the import time.
  createdAt?: string;
  // Any column that isn't email/first/last name/status/unsubscribed_at becomes a
  // custom attribute, keyed by a slug of its header (e.g. "Phone number" →
  // "phone_number"). These are usable as {{merge_tags}} in campaigns.
  attributes?: Record<string, string>;
};

export type CsvParseResult = {
  rows: CsvSubscriberRow[];
  totalRows: number;
  invalidRows: number;
  // Rows dropped because their `status` column says the address bounced,
  // complained, or never confirmed at the old provider. We refuse to import
  // those as contacts (see UNIMPORTABLE_STATUS_VALUES) — they belong on the
  // suppression list, which is a separate, deliberate act.
  statusSkippedRows: number;
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

// The reason a file can't be imported because of its header row, or null. Run
// at upload as well as in the worker, so "no email column" is an answer on the
// upload screen instead of an import that says "started" and then fails.
export function csvHeaderError(content: string): string | null {
  const lines = parseCsvLines(content);
  if (lines.length === 0) return "The CSV is empty.";
  const header = lines[0].map((h) => h.trim().toLowerCase());
  if (header.some((h) => HEADER_ALIASES[h] === "email")) return null;
  return (
    "We couldn't find an email column. The first row of the file should be column names, " +
    'with one called "email" (an export\u2019s "Email Address" works too).'
  );
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

// Decodes an uploaded CSV. UTF-8 when the bytes are valid UTF-8; otherwise
// Windows-1252, which is what Excel's "CSV (semicolon)" export writes on a Danish
// or most other European machines. Decoding that as UTF-8 turns "Søren" into
// a replacement character, which then lands in every greeting. The upload routes store the
// decoded text re-encoded as UTF-8, so the worker reads the same string.
export function decodeCsvBytes(bytes: ArrayBuffer | Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

// The decoded text as UTF-8 bytes, for storing the upload (see decodeCsvBytes).
export function utf8Body(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

// Excel can prefix a file with a "sep=;" line naming the separator. It is a hint
// for Excel, not a header row, so it is honoured and dropped.
const EXCEL_SEP_LINE = /^\uFEFF?sep=(.)\r?\n/i;

// The field separator, guessed from the header row. Comma is the standard, but
// Excel writes semicolons wherever the decimal mark is a comma (Denmark, most of
// Europe), and some tools export tabs. Whichever of the three appears most
// often outside quotes in the first line wins; a tie (or none) means comma.
function detectDelimiter(content: string): string {
  const counts: Record<string, number> = { ",": 0, ";": 0, "\t": 0 };
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch in counts) counts[ch]++;
  }
  let best = ",";
  for (const d of [";", "\t"]) if (counts[d] > counts[best]) best = d;
  return best;
}

// Minimal RFC-4180-ish parser: handles quoted fields, escaped quotes, CRLF, and
// a comma, semicolon or tab separator (see detectDelimiter).
function parseCsvLines(input: string): string[][] {
  const sepLine = EXCEL_SEP_LINE.exec(input);
  const content = sepLine ? input.slice(sepLine[0].length) : input;
  const delimiter = sepLine ? sepLine[1] : detectDelimiter(content);
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
    } else if (ch === delimiter) {
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

type KnownColumn =
  | "email"
  | "firstName"
  | "lastName"
  | "status"
  | "unsubscribedAt"
  | "createdAt"
  | "cleanedAt";

const HEADER_ALIASES: Record<string, KnownColumn> = {
  email: "email",
  "e-mail": "email",
  email_address: "email",
  // Mailchimp, Substack and most exports write it with a space.
  "email address": "email",
  "e-mail address": "email",
  emailaddress: "email",
  // Danish exports.
  "e-mailadresse": "email",
  emailadresse: "email",
  fornavn: "firstName",
  efternavn: "lastName",
  first_name: "firstName",
  firstname: "firstName",
  "first name": "firstName",
  last_name: "lastName",
  lastname: "lastName",
  "last name": "lastName",
  status: "status",
  subscription_status: "status",
  "subscription status": "status",
  unsubscribed_at: "unsubscribedAt",
  "unsubscribed at": "unsubscribedAt",
  unsubscribe_date: "unsubscribedAt",
  opted_out_at: "unsubscribedAt",
  // Provider exports (see PROVIDER_EXPORTS below for which file says what).
  subscriber: "email", // MailerLite's email column
  name: "firstName", // MailerLite's first-name field
  // Not `state`: Kit's export has a location `state` column ("TX") beside its
  // `status`, and reading that as a status would re-subscribe every opt-out.
  subscriber_status: "status",
  unsub_time: "unsubscribedAt", // Mailchimp unsubscribed_*.csv
  clean_time: "cleanedAt", // Mailchimp cleaned_*.csv
  created_at: "createdAt", // beehiiv, Kit
  "created at": "createdAt",
  subscribed_at: "createdAt", // MailerLite
  subscribed: "createdAt", // MailerLite's export header for the same date
  "subscribed at": "createdAt",
  "subscription date": "createdAt",
  optin_time: "createdAt", // Mailchimp (often empty; CONFIRM_TIME is the fallback)
  confirm_time: "createdAt",
};

// Which provider export each alias above comes from, with its source, so the
// next person can check them against a fresh export:
//   beehiiv   email, First Name, Last Name, status (active / inactive / pending /
//             validating / invalid), tier, created_at, unsubscribed_at.
//             From a real export in TryGhost/migrate (mg-beehiiv-members
//             fixtures); dates look like "2023-03-24 10:23:10 UTC".
//   Mailchimp Email Address, First Name, Last Name, merge fields, MEMBER_RATING,
//             OPTIN_TIME, ..., LEID, EUID, NOTES, TAGS. One file per status and
//             no status column: unsubscribed_*.csv adds UNSUB_TIME (+ UNSUB_*),
//             cleaned_*.csv adds CLEAN_TIME. Real exports in TryGhost/migrate
//             (mg-mailchimp-members fixtures); mailchimp.com/help/view-export-contacts.
//   Kit       first name, email, created_at, status, tags, custom fields
//             (help.kit.com "How to export subscribers"; literal header names
//             beyond created_at are not published, so both the help's words and
//             the API's names are aliased).
//   MailerLite "Subscriber" (email) plus whichever columns were visible, one
//             file per status filter (mailerlite.com/help/how-to-export-subscribers).
//
// Mailchimp's system columns are bookkeeping, not contact data. In a file that
// is recognisably a Mailchimp export (it has LEID and EUID) they are dropped
// instead of filling the audience's 50 custom fields with noise.
const MAILCHIMP_SYSTEM_COLUMNS = new Set([
  "member_rating",
  "optin_ip",
  "confirm_ip",
  "latitude",
  "longitude",
  "gmtoff",
  "dstoff",
  "timezone",
  "cc",
  "region",
  "last_changed",
  "leid",
  "euid",
  "notes",
  "unsub_campaign_title",
  "unsub_campaign_id",
  "unsub_reason_other",
  "clean_campaign_title",
  "clean_campaign_id",
]);

// Values a `status` column may carry that we map onto an importable status.
// Deliberately lenient: an *unrecognized* value (a `status` column that actually
// means something else, like "trial"/"paid") falls back to `subscribed`, which is
// exactly what happened before the column was read at all. Only words that
// clearly mean "this person opted out" change the outcome, so honoring the column
// can never silently swallow somebody's whole import.
const STATUS_VALUES: Record<string, CsvSubscriberStatus> = {
  subscribed: "subscribed",
  subscribe: "subscribed",
  subscriber: "subscribed",
  active: "subscribed",
  confirmed: "subscribed",
  yes: "subscribed",
  true: "subscribed",
  unsubscribed: "unsubscribed",
  unsubscribe: "unsubscribed",
  unsub: "unsubscribed",
  optout: "unsubscribed",
  "opt-out": "unsubscribed",
  "opt out": "unsubscribed",
  opted_out: "unsubscribed",
  "opted out": "unsubscribed",
  removed: "unsubscribed",
  inactive: "unsubscribed",
  no: "unsubscribed",
  false: "unsubscribed",
  // Provider export words.
  cancelled: "unsubscribed", // Kit
  canceled: "unsubscribed",
  paused: "unsubscribed", // beehiiv: the reader asked not to be mailed for now
  cold: "subscribed", // Kit: subscribed but unengaged
};

// Status values that mean the address is undeliverable, complained, or never
// confirmed at the source. These rows are dropped rather than imported: we will
// not assert a bounce we never observed, and importing them as `subscribed`
// would mail people the old provider had already stopped mailing. The skip is
// counted and reported, with a pointer to the suppression list.
const UNIMPORTABLE_STATUS_VALUES = new Set([
  "bounced",
  "bounce",
  "bounces",
  "hard_bounce",
  "hard bounce",
  "hardbounce",
  "soft_bounce",
  "soft bounce",
  "cleaned", // Mailchimp's word for a bounced address
  "complained",
  "complaint",
  "spam",
  "spam_complaint",
  "spam complaint",
  "abuse",
  "suppressed",
  "blocked",
  "blacklisted",
  "pending", // never completed double opt-in — no consent to inherit
  "unconfirmed",
  "not confirmed",
  "junk", // MailerLite's spam-complaint status
  "spam complaints",
  "validating", // beehiiv: address still being checked
  "invalid", // beehiiv: address found undeliverable
  "needs_attention", // beehiiv: awaiting approval
]);

// What a header column maps to: a known subscriber column, a custom attribute
// (keyed by a slug of the header), or nothing (blank header — skipped).
type ColumnTarget = { kind: KnownColumn } | { kind: "attribute"; key: string } | null;

// Parse a date cell into an ISO timestamp, or undefined when it isn't a date we
// understand — a garbled opt-out date must not abort the row, it just falls back
// to the import time.
//
// Provider exports write "2023-04-21 11:16:57" (Mailchimp, documented as UTC)
// and "2023-03-24 10:23:10 UTC" (beehiiv). JavaScript reads a zoneless
// date-time as LOCAL time, which would shift every date by the server's offset,
// so that shape is read as UTC explicitly.
function parseDateCell(value: string): string | undefined {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\s*UTC)?$/i.exec(value.trim());
  const ms = m ? Date.parse(`${m[1]}T${m[2]}Z`) : Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

const MAX_ATTR_VALUE_LEN = 500;

export function parseSubscriberCsv(content: string): CsvParseResult {
  const lines = parseCsvLines(content);
  if (lines.length === 0)
    return { rows: [], totalRows: 0, invalidRows: 0, statusSkippedRows: 0 };

  const header = lines[0].map((h) => h.trim().toLowerCase());
  const isMailchimpExport = header.includes("leid") && header.includes("euid");
  const hasStatusColumn = header.some((h) => HEADER_ALIASES[h] === "status");
  const columns: ColumnTarget[] = header.map((h) => {
    const alias = HEADER_ALIASES[h];
    if (alias) return { kind: alias };
    if (isMailchimpExport && MAILCHIMP_SYSTEM_COLUMNS.has(h)) return null;
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
  let statusSkippedRows = 0;

  for (const line of dataLines) {
    const record: Partial<CsvSubscriberRow> = {};
    const attributes: Record<string, string> = {};
    let unimportable = false;
    columns.forEach((col, i) => {
      if (!col) return;
      const value = (line[i] ?? "").trim();
      if (!value) return;
      if (col.kind === "email") record.email = canonicalizeEmail(value);
      else if (col.kind === "firstName") record.firstName = value;
      else if (col.kind === "lastName") record.lastName = value;
      else if (col.kind === "status") {
        const raw = value.toLowerCase();
        if (UNIMPORTABLE_STATUS_VALUES.has(raw)) unimportable = true;
        else record.status = STATUS_VALUES[raw] ?? "subscribed";
      } else if (col.kind === "unsubscribedAt") record.unsubscribedAt = parseDateCell(value);
      // Several columns can name the join date (Mailchimp's OPTIN_TIME is often
      // empty, CONFIRM_TIME is not); the first one with a date wins.
      else if (col.kind === "createdAt") record.createdAt ??= parseDateCell(value);
      // A Mailchimp cleaned_*.csv row: the address hard bounced there.
      else if (col.kind === "cleanedAt") unimportable = true;
      else if (col.kind === "attribute") attributes[col.key] = value.slice(0, MAX_ATTR_VALUE_LEN);
    });
    if (!record.email || !isValidEmail(record.email)) {
      invalidRows++;
      continue;
    }
    // An email that is otherwise fine but marked bounced/complained/pending is
    // counted under its own reason, not as "invalid" — the address is valid, we
    // are declining to mail it.
    if (unimportable) {
      statusSkippedRows++;
      continue;
    }
    // An opt-out date with no status column says the row is an opt-out: that is
    // how Mailchimp's unsubscribed_*.csv marks every row (UNSUB_TIME). With a
    // status column the status decides (a resubscribed reader can carry an old
    // date).
    if (!hasStatusColumn && record.unsubscribedAt) record.status = "unsubscribed";
    if (record.status !== "unsubscribed") delete record.unsubscribedAt;
    if (Object.keys(attributes).length > 0) record.attributes = attributes;
    rows.push(record as CsvSubscriberRow);
  }

  return { rows, totalRows: dataLines.length, invalidRows, statusSkippedRows };
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
  unsubscribedAt?: string | null;
  attributes?: Record<string, string> | null;
};

// Serialize subscribers back into the same CSV shape parseSubscriberCsv reads, so
// an export can be opened, edited, and re-imported cleanly — including opt-outs,
// which round-trip through `status` + `unsubscribed_at`. Columns are: email,
// first_name, last_name, status, unsubscribed_at, then the sorted union of every
// custom attribute key seen across the rows.
export function toSubscriberCsv(rows: SubscriberCsvRow[]): string {
  const attrKeys = new Set<string>();
  for (const r of rows) {
    if (r.attributes) for (const k of Object.keys(r.attributes)) attrKeys.add(k);
  }
  const sortedAttrKeys = [...attrKeys].sort();
  const header = [
    "email",
    "first_name",
    "last_name",
    "status",
    "unsubscribed_at",
    ...sortedAttrKeys,
  ];
  const lines = [header.map(csvField).join(",")];
  for (const r of rows) {
    lines.push(
      [
        r.email,
        r.firstName,
        r.lastName,
        r.status,
        r.unsubscribedAt,
        ...sortedAttrKeys.map((k) => r.attributes?.[k]),
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// Sample CSV handed to users from the import UI so they can see the expected
// shape. Only `email` is required; everything else is optional — `status` carries
// opt-outs over from another platform (with `unsubscribed_at` for the original
// date), and any further column becomes a custom {{merge_tag}} attribute.
export const SUBSCRIBER_CSV_TEMPLATE =
  "email,first_name,last_name,status,unsubscribed_at\r\n" +
  "jane@example.com,Jane,Doe,subscribed,\r\n" +
  "john@example.com,John,Smith,subscribed,\r\n" +
  "leavers@example.com,Sam,Lee,unsubscribed,2025-11-02\r\n";
