export type CsvSubscriberRow = {
  email: string;
  firstName?: string;
  lastName?: string;
};

export type CsvParseResult = {
  rows: CsvSubscriberRow[];
  totalRows: number;
  invalidRows: number;
};

export const MAX_IMPORT_ROWS = 5000;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

export function parseSubscriberCsv(content: string): CsvParseResult {
  const lines = parseCsvLines(content);
  if (lines.length === 0) return { rows: [], totalRows: 0, invalidRows: 0 };

  const header = lines[0].map((h) => h.trim().toLowerCase());
  const columns = header.map((h) => HEADER_ALIASES[h] ?? null);
  if (!columns.includes("email")) {
    throw new Error('CSV must include an "email" column');
  }

  const dataLines = lines.slice(1);
  const rows: CsvSubscriberRow[] = [];
  let invalidRows = 0;

  for (const line of dataLines) {
    const record: Partial<CsvSubscriberRow> = {};
    columns.forEach((col, i) => {
      if (!col) return;
      const value = (line[i] ?? "").trim();
      if (!value) return;
      if (col === "email") record.email = value.toLowerCase();
      else record[col] = value;
    });
    if (!record.email || !isValidEmail(record.email)) {
      invalidRows++;
      continue;
    }
    rows.push(record as CsvSubscriberRow);
  }

  return { rows, totalRows: dataLines.length, invalidRows };
}
