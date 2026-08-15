import { isIP } from "node:net";

// SSRF guard for outbound webhooks.
//
// A webhook URL is the one place in Day3 where a tenant hands us an address and
// our own server then makes a request to it — from inside the VPS network, with
// whatever the worker can reach. Unguarded, "https://169.254.169.254/latest/…"
// is a cloud-credential exfiltration primitive, and "http://localhost:6379" is a
// path to the Redis that holds every tenant's queue.
//
// Two layers, because either alone is insufficient:
//
//   1. validateWebhookUrl — structural, at create/update time. Rejects the
//      scheme, obviously-internal hostnames, and IP literals in blocked ranges,
//      so a bad URL never gets stored and the user sees the error in the form.
//
//   2. assertPublicAddress, wired as the connect-time `lookup` in the delivery
//      handler. Layer 1 can be defeated by DNS: a hostname that resolves to a
//      public address when saved can resolve to 169.254.169.254 an hour later
//      (DNS rebinding), and a validate-then-fetch pair has a window between the
//      two resolutions. Validating inside the socket's own lookup closes that
//      window — the address we check is the address it connects to.
//
// The delivery handler additionally never follows redirects, which removes the
// third classic vector (a public URL that 302s to the metadata endpoint).

export type UrlRejection =
  | "invalid_url"
  | "scheme_not_https"
  | "credentials_in_url"
  | "hostname_not_public"
  | "port_not_allowed";

export const URL_REJECTION_MESSAGES: Record<UrlRejection, string> = {
  invalid_url: "That doesn't look like a URL.",
  scheme_not_https: "Webhook URLs must use https://.",
  credentials_in_url: "Remove the username/password from the URL — sign requests with the signing secret instead.",
  hostname_not_public: "That address isn't reachable from the public internet. Use a public hostname (a tunnel like ngrok works for local development).",
  port_not_allowed: "Only ports 443 and 8443 are allowed.",
};

// Hostnames that never denote a public host. `.local` is mDNS, `.internal` is
// the GCP/AWS internal zone, `.localhost` is reserved by RFC 6761, and the
// bare single-label case ("redis", "db") is how a container reaches a sibling.
const BLOCKED_HOST_SUFFIXES = [".local", ".localhost", ".internal", ".intranet", ".home.arpa"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata", "metadata.google.internal"]);

// HTTPS only, so the port set is small on purpose. Allowing arbitrary ports
// would make the webhook sender a general-purpose internal port scanner (timing
// differences between "connection refused" and "TLS handshake" are observable
// in the delivery log we show the user).
const ALLOWED_PORTS = new Set([443, 8443]);

/**
 * Structural validation, at create/update time. Returns the normalized URL or a
 * rejection reason. Does NOT resolve DNS — that happens at connect time.
 */
export function validateWebhookUrl(raw: string): { ok: true; url: string } | { ok: false; reason: UrlRejection } {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "scheme_not_https" };
  // Credentials in the URL would end up in our delivery log and in the customer's
  // access log; the signature is the authentication mechanism here.
  if (url.username || url.password) return { ok: false, reason: "credentials_in_url" };

  const port = url.port ? Number(url.port) : 443;
  if (!ALLOWED_PORTS.has(port)) return { ok: false, reason: "port_not_allowed" };

  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!isPublicHostname(host)) return { ok: false, reason: "hostname_not_public" };

  return { ok: true, url: url.toString() };
}

function isPublicHostname(host: string): boolean {
  if (!host) return false;
  if (BLOCKED_HOSTS.has(host)) return false;
  if (BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) return false;

  // Bracketed IPv6 literal, as URL.hostname reports it.
  const unbracketed = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = isIP(unbracketed);
  if (family !== 0) return isPublicAddress(unbracketed, family === 6 ? 6 : 4);

  // A single-label name ("redis", "backend") is a container/LAN name, never a
  // public FQDN. Anything with a dot goes to DNS, where the connect-time guard
  // is the real check.
  return host.includes(".");
}

// --- Address classification -------------------------------------------------

function ipv4ToInt(addr: string): number | null {
  const parts = addr.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const p of parts) {
    // Reject empty, non-numeric, out-of-range, and octal-ish forms ("010") —
    // the last of these is parsed differently by different resolvers, which is
    // itself a bypass technique.
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out >>> 0;
}

// Blocked IPv4 CIDRs: everything that isn't globally routable unicast.
const BLOCKED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — AWS/GCP/Azure instance metadata
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved + 255.255.255.255
];

function isPublicV4(addr: string): boolean {
  const ip = ipv4ToInt(addr);
  if (ip === null) return false;
  for (const [base, bits] of BLOCKED_V4) {
    const baseInt = ipv4ToInt(base);
    if (baseInt === null) continue;
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((ip & mask) === (baseInt & mask)) return false;
  }
  return true;
}

// Expand an IPv6 address to its 16 bytes. Returns null on anything unparseable —
// which the caller treats as "not public", i.e. fail closed.
function ipv6Bytes(addr: string): Uint8Array | null {
  let text = addr;
  // Zone index ("fe80::1%eth0") — strip it; the address itself is what matters.
  const pct = text.indexOf("%");
  if (pct >= 0) text = text.slice(0, pct);

  // An embedded IPv4 tail ("::ffff:1.2.3.4") — convert it to two hextets.
  const v4Tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(text);
  if (v4Tail) {
    const int = ipv4ToInt(v4Tail[1]);
    if (int === null) return null;
    const hi = (int >>> 16).toString(16);
    const lo = (int & 0xffff).toString(16);
    text = text.slice(0, v4Tail.index) + `${hi}:${lo}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(":") : []) : [];
  const groups: string[] =
    halves.length === 2
      ? [...head, ...Array(8 - head.length - tail.length).fill("0"), ...tail]
      : head;
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < 8; i++) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(groups[i])) return null;
    const n = parseInt(groups[i], 16);
    bytes[i * 2] = n >>> 8;
    bytes[i * 2 + 1] = n & 0xff;
  }
  return bytes;
}

function isPublicV6(addr: string): boolean {
  const b = ipv6Bytes(addr);
  if (!b) return false;

  // IPv4-mapped (::ffff:0:0/96) and IPv4-translated (64:ff9b::/96): the real
  // destination is the embedded IPv4, so classify it as IPv4 or the whole
  // v4 blocklist is trivially bypassed by wrapping the address.
  const isV4Mapped =
    b.slice(0, 10).every((x) => x === 0) && b[10] === 0xff && b[11] === 0xff;
  const isNat64 =
    b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b &&
    b.slice(4, 12).every((x) => x === 0);
  if (isV4Mapped || isNat64) {
    return isPublicV4(`${b[12]}.${b[13]}.${b[14]}.${b[15]}`);
  }

  if (b.every((x) => x === 0)) return false; // ::
  if (b.slice(0, 15).every((x) => x === 0) && b[15] === 1) return false; // ::1
  if ((b[0] & 0xfe) === 0xfc) return false; // fc00::/7 unique-local
  if (b[0] === 0xfe && (b[1] & 0xc0) === 0x80) return false; // fe80::/10 link-local
  if (b[0] === 0xff) return false; // ff00::/8 multicast
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return false; // 2001:db8::/32

  return true;
}

/** True when `addr` is a globally routable unicast address. Fails closed. */
export function isPublicAddress(addr: string, family: 4 | 6): boolean {
  return family === 4 ? isPublicV4(addr) : isPublicV6(addr);
}
