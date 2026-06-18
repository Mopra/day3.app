// Lightweight DoH (DNS-over-HTTPS) resolver used to confirm the DKIM CNAMEs are
// live in public DNS the moment after we write them — independent of AWS SES's
// slow background re-check. This lets the UI show "DNS confirmed" within seconds
// (the part we control), while SES verification catches up on its own clock.
import type { DnsRecord } from "../lib/types";

const DOH_URL = "https://cloudflare-dns.com/dns-query";

function normalizeTarget(value: string): string {
  return value.trim().replace(/\.$/, "").toLowerCase(); // drop trailing dot, case-fold
}

type DohAnswer = { name: string; type: number; data: string };
type DohResponse = { Status: number; Answer?: DohAnswer[] };

// Does `name` resolve to a CNAME pointing at `expected`? Resilient: any network
// or parse failure returns false (treated as "not confirmed yet"), never throws.
export async function cnameResolves(name: string, expected: string): Promise<boolean> {
  try {
    const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=CNAME`;
    const res = await fetch(url, { headers: { accept: "application/dns-json" } });
    if (!res.ok) return false;
    const body = (await res.json()) as DohResponse;
    if (body.Status !== 0 || !body.Answer?.length) return false;
    const want = normalizeTarget(expected);
    return body.Answer.some((a) => normalizeTarget(a.data) === want);
  } catch {
    return false;
  }
}

// True once every REQUIRED record (the DKIM CNAMEs) resolves to its expected
// target. Recommended records (DMARC) don't gate verification, so they're
// ignored here. Empty required set → false (nothing to confirm).
export async function requiredRecordsResolve(records: DnsRecord[]): Promise<boolean> {
  const required = records.filter((r) => r.required && r.type === "CNAME");
  if (required.length === 0) return false;
  const checks = await Promise.all(required.map((r) => cnameResolves(r.name, r.value)));
  return checks.every(Boolean);
}
