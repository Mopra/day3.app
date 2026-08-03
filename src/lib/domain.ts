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

// The cron stops re-checking a pending domain once its row has been untouched
// for this long (see queue/cron.ts), to bound SES calls on abandoned domains.
// Kept here so the UI and the cron agree on the same window.
export const DOMAIN_RECHECK_WINDOW_DAYS = 14;

// A pending domain whose last update is older than the recheck window: the cron
// has quietly stopped polling it, so the UI must surface a "needs attention,
// re-check now" state instead of an endless spinner. Verified/failed domains and
// rows without a usable timestamp are never considered stale.
export function recheckWindowExpired(d: SendingDomain, now: number = Date.now()): boolean {
  if (domainState(d) !== "pending") return false;
  const updated = d.updatedAt ?? d.createdAt;
  const ts = Date.parse(updated);
  if (Number.isNaN(ts)) return false;
  return now - ts > DOMAIN_RECHECK_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

// Is this domain's DKIM failure the recoverable kind?
//
// SES polls for the DKIM CNAMEs for 72 hours after the identity is created, then
// parks the status at FAILED and never re-polls — so records added on day 4 leave
// the domain broken forever. If those records provably resolve in public DNS then
// nothing is wrong at the DNS host: the verification window merely closed, and
// reopening it (see restartDkim) is the only way forward.
//
// Shared deliberately: the /check route uses this to decide whether to restart,
// and the setup guide uses it to decide whether to tell the user a retry will
// work. Two independent conditions would eventually disagree and the UI would
// promise a fix that never runs.
export function dkimWindowClosed(dkimStatus: string, requiredRecordsResolve: boolean): boolean {
  return dkimStatus === "failed" && requiredRecordsResolve;
}

// Safe-parse the stored records. Legacy rows predate the `required` and `group`
// flags, so we default them (those were DKIM CNAMEs — required, verify group).
// Stored values override the defaults via the spread.
export function parseDnsRecords(json?: string | null): DnsRecord[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((r) => ({ required: true, group: "verify" as const, ...r }));
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
