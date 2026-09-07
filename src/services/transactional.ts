// Shared vocabulary of the transactional email system (POST /v1/emails → the
// send_transactional worker job). Constants and pure helpers only — the API
// route owns validation/enqueue, the queue handler owns the actual send.
import type { SuppressionReason } from "../db/schema";
import { isValidEmail } from "../lib/csv";

// The suppression reasons that block a transactional send: deliverability
// protections only. `unsubscribe` deliberately does NOT block — unsubscribing
// from marketing must never block a password reset or receipt.
export const TRANSACTIONAL_SUPPRESSION_REASONS: SuppressionReason[] = [
  "hard_bounce",
  "complaint",
  "provider_suppressed",
];

// Resend-compatible ceiling: one message, up to 50 visible To addresses.
export const MAX_TRANSACTIONAL_RECIPIENTS = 50;

// The sandbox carve-out for free (set-up-only) orgs — real sends to the org's
// own members, on a small shared monthly allowance — is not transactional-only:
// campaigns run in the same mode on the free tier, against the same allowance.
// It lives in services/sandbox.ts; re-exported here so the transactional call
// sites keep reading as one vocabulary.
export { SANDBOX_MONTHLY_ALLOWANCE } from "./sandbox";

// Bodies (html/text) are nulled by the daily cron once an email is older than
// this; the metadata row survives for the log/API. Full HTML documents at
// transactional volume would otherwise grow the table without bound.
export const TRANSACTIONAL_BODY_RETENTION_DAYS = 30;

// Size caps enforced at the API boundary.
export const MAX_HTML_BYTES = 1_000_000;
export const MAX_TEXT_BYTES = 500_000;
// Aggregate ceiling across html + text + headers + tags, measured in real UTF-8
// bytes. The per-field caps alone would allow ~1.5M code units (up to ~6 MB of
// multibyte UTF-8) per request, which at the send rate limit is hundreds of MB
// of row writes per minute per tenant, retained for the body-retention window.
// Well above any real transactional email; it only bounds abuse.
export const MAX_TOTAL_BYTES = 1_500_000;
export const MAX_SUBJECT_LENGTH = 998; // RFC 5322 line limit
export const MAX_CUSTOM_HEADERS = 20;
export const MAX_TAGS = 10;

// Attribution headers the send handler always stamps on outbound mail. Callers
// may not set them (they're in the reserved list) AND the handler merges them
// case-insensitively, so a `x-account-id` variant can't ride alongside ours and
// point forensics at another tenant's id.
export const PLATFORM_HEADERS = {
  accountId: "X-Account-ID",
  transactionalEmailId: "X-Transactional-Email-ID",
} as const;

const PLATFORM_HEADER_NAMES_LOWER = Object.values(PLATFORM_HEADERS).map((h) => h.toLowerCase());

// Caller headers minus anything colliding (case-insensitively) with a platform
// header, then the platform headers. Used at send time; the API boundary
// already 400s these names, so this is defense in depth for older rows.
export function mergeSendHeaders(
  caller: Record<string, string> | null | undefined,
  platform: Record<string, string>,
): Record<string, string> {
  const reserved = new Set(Object.keys(platform).map((k) => k.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(caller ?? {})) {
    if (!reserved.has(name.trim().toLowerCase())) out[name] = value;
  }
  return { ...out, ...platform };
}

// Headers the caller may NOT set. Four groups, all rejected at the API boundary
// with a 400 rather than left to fail (or worse, succeed) at the provider:
//   1. Derived from the request body itself (from/to/subject/reply-to/…) — set
//      via the documented fields instead.
//   2. MIME/transport plumbing the provider owns.
//   3. Authentication and trace headers. A caller-supplied `DKIM-Signature`,
//      `Authentication-Results`, `ARC-*`, `Received` or `Sender` is only ever
//      an attempt to make forged mail look verified to a naive downstream
//      filter — never a legitimate need.
//   4. Platform-owned headers: the unsubscribe machinery (transactional mail
//      carries none), our own attribution headers (see the case-insensitive
//      merge in the send handler), and `X-SES-*` — of which
//      X-SES-CONFIGURATION-SET is the dangerous one: honored, it would redirect
//      event publishing away from our SNS topic and blind bounce/complaint
//      tracking for that message.
// Checked trimmed + lowercased; `x-ses-*` and `arc-*` are prefix-matched.
const RESERVED_HEADERS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "reply-to",
  "return-path",
  "content-type",
  "content-transfer-encoding",
  "content-disposition",
  "content-id",
  "mime-version",
  "date",
  "message-id",
  "list-unsubscribe",
  "list-unsubscribe-post",
  "dkim-signature",
  "authentication-results",
  "received",
  "received-spf",
  "sender",
  "resent-from",
  "resent-to",
  "resent-cc",
  "resent-bcc",
  "resent-date",
  "resent-message-id",
  ...PLATFORM_HEADER_NAMES_LOWER,
]);

const RESERVED_HEADER_PREFIXES = ["x-ses-", "arc-"];

export function isReservedHeader(name: string): boolean {
  const lower = name.trim().toLowerCase();
  return (
    RESERVED_HEADERS.has(lower) || RESERVED_HEADER_PREFIXES.some((p) => lower.startsWith(p))
  );
}

// Sendable-address strictness on top of the house-wide isValidEmail: reject
// characters that are RFC-quotable in theory but in practice only appear in
// header-smuggling attempts (angle brackets, commas, quotes, parens, control
// characters). These addresses go straight into provider To/From/Reply-To
// fields, and an accept-time 400 beats a confusing provider-side failure —
// or worse, a parser disagreement about where one address ends.
export function isSendableAddress(email: string): boolean {
  // eslint-disable-next-line no-control-regex
  return isValidEmail(email) && !/[<>,;:"()[\]\\\x00-\x1f\x7f]/.test(email);
}

// Characters that end a display name's innocence: anything that could open a
// second mailbox (`<`), close the quoting we apply at the SES boundary, or
// smuggle a header fold. Rejected rather than stripped — a From the caller
// didn't write is worse than a 400.
// eslint-disable-next-line no-control-regex
const UNSAFE_DISPLAY_NAME = /[<>"\\\x00-\x1f\x7f]/;

// Parses a From value in either accepted shape: "notify@acme.com" or
// "Acme <notify@acme.com>". Returns null when it isn't a plausible address —
// the caller turns that into a 400 with param "from". Deliberately narrow: no
// comment syntax, no address lists, no specials in the display name. This is
// a security boundary, not just parsing: the display name must never be able
// to carry a second `<mailbox>` — in a shared SES account, a smuggled address
// on ANOTHER tenant's verified domain would otherwise ride on their
// reputation (the SES-side identity check is account-wide, not per-tenant).
export function parseFromAddress(raw: string): { email: string; name: string | null } | null {
  const trimmed = raw.trim();
  const angled = /^(.*)<([^<>\s]+@[^<>\s]+)>$/.exec(trimmed);
  if (angled) {
    const email = angled[2].toLowerCase();
    if (!isSendableAddress(email)) return null;
    // Strip optional surrounding quotes from the display name, then reject any
    // name that still carries quoting/bracket/control characters.
    const name = angled[1].trim().replace(/^"(.*)"$/s, "$1").trim();
    if (UNSAFE_DISPLAY_NAME.test(name)) return null;
    return { email, name: name || null };
  }
  if (!isSendableAddress(trimmed)) return null;
  return { email: trimmed.toLowerCase(), name: null };
}

// The domain part of an address, for matching against the account's verified
// sending domains.
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf("@") + 1).toLowerCase();
}

// --- One-click unsubscribe (RFC 8058) ---------------------------------------
//
// `List-Unsubscribe` and `List-Unsubscribe-Post` are in RESERVED_HEADERS, so a
// caller cannot smuggle them through `headers`. That default is right for the
// mail this API was built for: a password reset carries no unsubscribe, and a
// caller who sets one by hand gets the pair subtly wrong (a bare URL instead of
// `<URL>`, or the POST header without the `One-Click` value) often enough that
// accepting raw header strings would mostly produce broken headers.
//
// But some legitimate senders on this API are bulk-shaped rather than
// transactional — cold outreach with a real opt-out, operational digests, a
// one-off announcement — and for those, RFC 8058 is a deliverability
// requirement at Gmail and Yahoo and a legal one under CAN-SPAM. So the
// capability is exposed as ONE validated field, `list_unsubscribe`, and this
// module owns turning it into the header pair. The caller supplies the URL; we
// supply the correctness.
//
// https is required. A one-click unsubscribe is a state-changing POST from a
// mail client the sender does not control, and over http it is both
// interceptable and ignored by the providers that matter.

export const MAX_LIST_UNSUBSCRIBE_URL_LENGTH = 1000;

/**
 * Validates a caller-supplied one-click unsubscribe URL. Returns the normalized
 * URL, or null when it is not something we are willing to put in a header.
 *
 * Deliberately narrow: https only, no embedded credentials, no whitespace or
 * control characters, and no angle brackets (the caller passes a bare URL and
 * we add the brackets, so a caller who included them would otherwise produce
 * `<<url>>`).
 */
export function parseListUnsubscribeUrl(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LIST_UNSUBSCRIBE_URL_LENGTH) return null;
  // eslint-disable-next-line no-control-regex
  if (/[<>\s\x00-\x1f\x7f]/.test(trimmed)) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (!url.hostname.includes(".")) return null;

  return url.toString();
}

/**
 * The RFC 8058 header pair for a validated URL, or an empty object when there
 * is none. Both headers together or neither: `List-Unsubscribe-Post` without a
 * `List-Unsubscribe` target is meaningless, and a `List-Unsubscribe` without
 * the POST header is the old two-click form that Gmail no longer counts.
 */
export function listUnsubscribeHeaders(url: string | null | undefined): Record<string, string> {
  if (!url) return {};
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
