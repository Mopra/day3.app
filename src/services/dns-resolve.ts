// Lightweight DoH (DNS-over-HTTPS) resolver used to confirm a domain's records
// are live in public DNS the moment after we (or the customer) add them —
// independent of AWS SES's slow background re-check. This lets the UI show each
// record's status ("Found" / "Waiting") within seconds, while SES verification
// catches up on its own clock.
import type { DnsRecord } from "../lib/types";

const DOH_URL = "https://cloudflare-dns.com/dns-query";

function normalizeTarget(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase(); // drop trailing dot, case-fold
}

// TXT answers come back quoted and may be split into adjacent chunks
// (`"part1" "part2"`). Join chunks, drop quotes, collapse whitespace, case-fold.
function normalizeTxt(data: string): string {
  return data
    .replace(/"\s+"/g, "") // concatenate adjacent quoted chunks
    .replace(/"/g, "") // strip remaining quotes
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

type DohAnswer = { name: string; type: number; data: string };
type DohResponse = { Status: number; Answer?: DohAnswer[] };

// Fetch the answer `data` strings for a name/type. Resilient: any network, HTTP,
// status (non-zero ⇒ no records), or parse failure returns [] — never throws.
async function dohData(name: string, type: "CNAME" | "TXT" | "MX"): Promise<string[]> {
  try {
    const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${type}`;
    const res = await fetch(url, { headers: { accept: "application/dns-json" } });
    if (!res.ok) return [];
    const body = (await res.json()) as DohResponse;
    if (body.Status !== 0 || !body.Answer?.length) return [];
    return body.Answer.map((a) => a.data);
  } catch {
    return [];
  }
}

// Does `name` resolve to a CNAME pointing at `expected`? (Trailing-dot/case
// insensitive.) Resilient: failure ⇒ false.
export async function cnameResolves(name: string, expected: string): Promise<boolean> {
  const want = normalizeTarget(expected);
  const answers = await dohData(name, "CNAME");
  return answers.some((a) => normalizeTarget(a) === want);
}

// The identifying token(s) a TXT answer must contain to count as a match. We
// match on meaning, not byte-equality, because DNS hosts reorder/space/quote
// records differently. SPF: must include the SES include. DMARC: just the
// version tag (the user may legitimately run a stricter policy than our default).
function txtNeedles(expected: string): string[] {
  const e = expected.toLowerCase();
  if (e.includes("v=spf1")) return ["v=spf1", "include:amazonses.com"];
  if (e.includes("v=dmarc1")) return ["v=dmarc1"];
  return [normalizeTxt(expected)];
}

// Does a TXT record at `name` contain the meaningful tokens of `expected`?
export async function txtResolves(name: string, expected: string): Promise<boolean> {
  const answers = await dohData(name, "TXT");
  if (!answers.length) return false;
  const needles = txtNeedles(expected);
  return answers.some((a) => {
    const value = normalizeTxt(a);
    return needles.every((n) => value.includes(n));
  });
}

// Does an MX record at `name` point at `expectedTarget`? MX answers look like
// "10 feedback-smtp.us-east-1.amazonses.com." — we compare the host only;
// priority is advisory for a read (it matters for the Cloudflare write).
export async function mxResolves(name: string, expectedTarget: string): Promise<boolean> {
  const want = normalizeTarget(expectedTarget);
  const answers = await dohData(name, "MX");
  return answers.some((a) => {
    const host = a.trim().split(/\s+/).pop() ?? "";
    return normalizeTarget(host) === want;
  });
}

async function recordResolves(r: DnsRecord): Promise<boolean> {
  if (r.type === "CNAME") return cnameResolves(r.name, r.value);
  if (r.type === "TXT") return txtResolves(r.name, r.value);
  if (r.type === "MX") return mxResolves(r.name, r.value);
  return false;
}

export type RecordResolution = { name: string; type: string; resolved: boolean };
export type DnsResolution = { records: RecordResolution[]; requiredResolved: boolean };

// Resolve every record to a live/not-live boolean and compute requiredResolved =
// all group:"verify" records (the DKIM CNAMEs) resolve. Deliverability records
// (Return-Path MX/SPF, DMARC) report their own status but never gate. Empty
// verify set ⇒ false (nothing to confirm yet).
export async function resolveRecords(records: DnsRecord[]): Promise<DnsResolution> {
  const results: RecordResolution[] = await Promise.all(
    records.map(async (r) => ({
      name: r.name,
      type: r.type,
      resolved: await recordResolves(r),
    })),
  );
  const verifyIdx = records
    .map((r, i) => ((r.group ?? "verify") === "verify" ? i : -1))
    .filter((i) => i >= 0);
  const requiredResolved = verifyIdx.length > 0 && verifyIdx.every((i) => results[i].resolved);
  return { records: results, requiredResolved };
}

// Back-compat boolean: true once every required (group:"verify") record resolves.
export async function requiredRecordsResolve(records: DnsRecord[]): Promise<boolean> {
  return (await resolveRecords(records)).requiredResolved;
}
