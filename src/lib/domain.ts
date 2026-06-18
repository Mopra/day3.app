import type { DnsRecord, DomainState, SendingDomain } from "@/lib/types";

// A domain can send once SES reports it verified OR an admin flips the override.
export function domainState(d: SendingDomain): DomainState {
  if (d.adminOverrideVerified || d.verificationStatus === "verified") return "verified";
  if (d.verificationStatus === "failed") return "failed";
  return "pending";
}

export function isVerified(d: SendingDomain): boolean {
  return domainState(d) === "verified";
}

// Safe-parse the stored records. Legacy rows predate the `required` flag, so we
// default it to true (those were DKIM CNAMEs, which are required).
export function parseDnsRecords(json?: string | null): DnsRecord[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((r) => ({ required: true, ...r }));
  } catch {
    return [];
  }
}

// Best-effort registrable root (last two labels). Good enough to offer a
// "host only" view of records; the full name is always shown as the safe default.
export function registrableRoot(domain: string): string {
  const labels = domain.split(".").filter(Boolean);
  if (labels.length <= 2) return domain;
  return labels.slice(-2).join(".");
}

// The host portion most DNS UIs expect: the record name with the root stripped.
// Returns "@" for the apex. Falls back to the full name if it isn't under root.
export function relativeHost(name: string, root: string): string {
  if (name === root) return "@";
  const suffix = `.${root}`;
  if (name.endsWith(suffix)) return name.slice(0, -suffix.length);
  return name;
}
