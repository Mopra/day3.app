export type RenderInput = {
  campaign: {
    subject: string;
    htmlBody: string;
    textBody?: string | null;
    // Editable footer wording. Null/empty → DEFAULT_FOOTER_TEXT. The address and
    // unsubscribe link are always appended canonically regardless of this value.
    footerText?: string | null;
  };
  subscriber: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  };
  companyName: string;
  companyAddress?: string | null;
  unsubscribeUrl: string;
  // Absolute URL of the per-recipient open-tracking pixel. When set, a hidden
  // 1×1 image is appended to the HTML body so a load records an open. Omitted
  // (null/undefined) — e.g. when no public app URL is configured — sends no
  // pixel and the HTML is unchanged.
  openTrackingUrl?: string | null;
  // Map of original (sanitized) href → click-tracking redirect URL. When set,
  // matching content links in the body are rewritten to redirect through the
  // tracker. Built per recipient (each token is recipient-specific). The footer
  // unsubscribe link is appended afterwards and is never tracked.
  linkTracking?: Record<string, string> | null;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

// The default footer wording, used when a campaign hasn't customised it. Editable
// by the user (see campaigns.footerText); {{company_name}} is substituted at send.
export const DEFAULT_FOOTER_TEXT =
  "You are receiving this email because you subscribed to updates from {{company_name}}.";

// The locked, canonical tail appended after the (editable) footer wording. These
// two lines — the physical mailing address and the single working unsubscribe
// link — are required for compliance and are never user-editable.
const FOOTER_LOCKED_HTML = `
<p>{{company_address}}</p>
<p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>
`;

const FOOTER_LOCKED_TEXT = `{{company_address}}
Unsubscribe: {{unsubscribe_url}}
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Substitutes {{merge_tag}} placeholders. Merge values are attacker-controllable
// (imported from CSV with no HTML escaping) and substitution runs AFTER the body
// is sanitized, so every value MUST be HTML-escaped to prevent injecting live
// markup/handlers into the already-sanitized output. The only exception is the
// trusted, server-generated unsubscribe_url, which we control and which must
// remain usable as a real href.
// Tokens may carry a fallback used when the field is empty: {{first_name|there}}
// renders "there" for subscribers with no first name, so personalized copy never
// degrades to "Hi ," or a blank gap. The fallback text is itself escaped/treated
// as plain text — it is author-supplied, never the (untrusted) merge value.
const TOKEN_RE = /\{\{\s*([a-z_]+)\s*(?:\|\s*([^}]*))?\}\}/gi;

// Subscriber fields that may be blank and so produce an empty (awkward) merge.
// `email` is always present; company_*/unsubscribe_url are not subscriber data.
// Used by the pre-send personalization check to warn about recipients missing a
// field the campaign actually references.
export const PERSONALIZABLE_FIELDS = ["first_name", "last_name"] as const;
export type PersonalizableField = (typeof PERSONALIZABLE_FIELDS)[number];

export type PersonalizationUsage = {
  field: PersonalizableField;
  // The fallback the campaign supplies for this field (the first one seen), or
  // null if at least one usage has no fallback — i.e. an empty field renders blank.
  fallback: string | null;
};

// Which personalizable fields a campaign references, with the fallback that will
// show when the field is empty. A field with any bare ({{first_name}}) usage is
// reported with fallback null, since that usage degrades to blank.
export function personalizationFieldsUsed(
  ...texts: (string | null | undefined)[]
): PersonalizationUsage[] {
  const seen = new Map<PersonalizableField, string | null>();
  for (const text of texts) {
    if (!text) continue;
    for (const m of text.matchAll(TOKEN_RE)) {
      const key = m[1].toLowerCase();
      if (!(PERSONALIZABLE_FIELDS as readonly string[]).includes(key)) continue;
      const field = key as PersonalizableField;
      const fallback = (m[2] ?? "").trim() || null;
      // A bare usage (no fallback) wins — it's the one that renders blank, so the
      // warning should reflect the worst case.
      if (!seen.has(field)) seen.set(field, fallback);
      else if (seen.get(field) != null && fallback == null) seen.set(field, null);
    }
  }
  return PERSONALIZABLE_FIELDS.filter((f) => seen.has(f)).map((f) => ({
    field: f,
    fallback: seen.get(f) ?? null,
  }));
}

function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(TOKEN_RE, (_, name: string, fallback?: string) => {
    const key = name.toLowerCase();
    if (!(key in vars)) return "";
    const value = vars[key] !== "" ? vars[key] : (fallback ?? "").trim();
    return key === "unsubscribe_url" ? value : escapeHtml(value);
  });
}

// Like substitute() but for the plain-text body, where HTML escaping is wrong.
function substituteText(template: string, vars: Record<string, string>): string {
  return template.replace(TOKEN_RE, (_, name: string, fallback?: string) => {
    const key = name.toLowerCase();
    if (!(key in vars)) return "";
    return vars[key] !== "" ? vars[key] : (fallback ?? "").trim();
  });
}

// Conservative allowlist for newsletter-safe markup. Anything not on this list
// is stripped (tag removed, content kept). We do NOT support arbitrary HTML:
// campaign bodies are simple newsletter content, and we share sender reputation
// across tenants, so unsafe markup is a deliverability/reputation risk.
const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "div", "em", "h1", "h2", "h3", "h4",
  "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "span", "strong",
  "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
]);

// Attributes allowed per tag. Everything else (including all on* handlers and
// style) is dropped.
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
};

// Decodes HTML character references (named + numeric, decimal and hex) so the
// scheme check below sees the same string the email client will after it parses
// the attribute. Without this, `&#106;avascript:` slips through as a "relative"
// URL but a decoding client runs javascript:.
function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    "#39": "'",
    colon: ":",
    tab: "\t",
    newline: "\n",
  };
  return value.replace(/&(#x?[0-9a-f]+|[a-z]+);?/gi, (match, body: string) => {
    const lower = body.toLowerCase();
    if (lower[0] === "#") {
      const code =
        lower[1] === "x"
          ? Number.parseInt(lower.slice(2), 16)
          : Number.parseInt(lower.slice(1), 10);
      if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    return lower in named ? named[lower] : match;
  });
}

// URL schemes we permit in href/src. Blocks javascript:, data:, vbscript:, etc.
// Protocol-relative ("//host") and relative URLs are allowed. The value is
// HTML-entity-decoded first so entity-encoded schemes (e.g. &#106;avascript:)
// are evaluated as the client will see them, not as a harmless relative URL.
function isSafeUrl(value: string): boolean {
  const decoded = decodeHtmlEntities(value).trim();
  // eslint-disable-next-line no-control-regex
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(decoded.replace(/[\x00-\x20]/g, ""));
  if (!scheme) return true; // relative or anchor URL
  return ["http", "https", "mailto"].includes(scheme[1].toLowerCase());
}

function buildAttrs(tag: string, rawAttrs: string): string {
  const allowed = ALLOWED_ATTRS[tag];
  if (!allowed) return "";
  let out = "";
  const attrRe = /([a-z][a-z0-9-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/gi;
  let m: RegExpExecArray | null;
  while ((m = attrRe.exec(rawAttrs)) !== null) {
    const name = m[1].toLowerCase();
    if (!allowed.has(name)) continue;
    const value = m[3] ?? m[4] ?? m[5] ?? "";
    if (name === "href" || name === "src") {
      // isSafeUrl runs HERE, during sanitization, BEFORE substitute() injects
      // attacker-controlled merge values (first_name/last_name/email from CSV).
      // A template like <a href="{{first_name}}"> passes isSafeUrl now (it looks
      // like a relative URL) but becomes href="javascript:..." after the merge
      // value is substituted — and escapeHtml() does not encode ':' so the
      // scheme survives, yielding a live javascript:/data:/etc. URL in the
      // delivered email. We cannot safely re-validate post-substitution because
      // values are merged into the whole HTML string at once, so we refuse any
      // href/src whose value still contains a {{...}} placeholder. The only
      // dynamic URL we support is the trusted unsubscribe_url, which is injected
      // by the canonical footer (not by user templates).
      if (/\{\{/.test(value)) continue;
      if (!isSafeUrl(value)) continue;
    }
    out += ` ${name}="${escapeHtml(value)}"`;
  }
  return out;
}

// Renders a single sanitized tag from its parsed parts, applying the tag and
// attribute allowlists.
function sanitizeTag(slash: string, name: string, rawAttrs: string): string {
  const tag = name.toLowerCase();
  if (!ALLOWED_TAGS.has(tag)) return "";
  if (slash) return `</${tag}>`;
  return `<${tag}${buildAttrs(tag, rawAttrs)}>`;
}

// Minimal HTML sanitizer: drops disallowed tags (keeping their text content),
// removes the contents of dangerous tags entirely (<script>/<style>/<iframe>),
// and filters attributes against the allowlist. Not a full DOM parser — it
// matches the lightweight, dependency-free approach used by htmlToText below.
//
// A regex pass alone is unsafe here: a tag with an unterminated attribute quote
// (e.g. `<img src="x" onerror="..." alt="`) has no reachable `>` for a quote-
// aware tag regex to match, so the whole tag would pass through VERBATIM —
// including its live on* handler — and a later-appended `"` (e.g. from the
// footer's href) closes the dangling quote, yielding stored XSS. So we scan
// linearly, locate each tag's real `>` terminator while honoring quoted
// attribute values, and DROP any tag we cannot fully terminate (along with the
// untrustworthy remainder) rather than emit it raw.
export function sanitizeHtml(html: string): string {
  // Drop comments and the entire contents of script-like/style/embed tags.
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    // Unclosed dangerous tags: strip from the opening tag to end of input.
    .replace(/<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*$/gi, "");

  let out = "";
  let i = 0;
  const len = cleaned.length;
  while (i < len) {
    const lt = cleaned.indexOf("<", i);
    if (lt === -1) {
      out += cleaned.slice(i);
      break;
    }
    out += cleaned.slice(i, lt);

    // Is this '<' the start of an open/close tag? If not (e.g. "3 < 5"),
    // neutralize the stray '<' as text and move on.
    const open = /^<\s*(\/?)([a-z][a-z0-9]*)\b/i.exec(cleaned.slice(lt));
    if (!open) {
      out += "&lt;";
      i = lt + 1;
      continue;
    }

    // Find the tag's real terminating '>', skipping any '>' that sits inside a
    // quoted attribute value. A '>' inside a quoted value must NOT end the tag,
    // and a quote that never closes means the tag is malformed.
    let j = lt + open[0].length;
    let quote: string | null = null;
    let end = -1;
    for (; j < len; j++) {
      const c = cleaned[j];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === ">") {
        end = j;
        break;
      }
    }

    if (end === -1) {
      // Unterminated tag (e.g. a dangling attribute quote). Drop it AND the rest
      // of the input: nothing after a broken tag can be trusted, and emitting it
      // verbatim is exactly the bypass we are closing.
      break;
    }

    const rawAttrs = cleaned.slice(lt + open[0].length, end);
    out += sanitizeTag(open[1], open[2], rawAttrs);
    i = end + 1;
  }

  return out;
}

// Removes any user-supplied unsubscribe markup so the canonical footer is the
// single source of truth. Strips both literal {{unsubscribe_url}} placeholders
// and anchor tags that already point at an unsubscribe URL.
function stripUserUnsubscribe(html: string): string {
  return html
    .replace(/<a\b[^>]*href="[^"]*\{\{\s*unsubscribe_url\s*\}\}[^"]*"[^>]*>[\s\S]*?<\/a>/gi, "")
    .replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, "");
}

function stripUserUnsubscribeText(text: string): string {
  return text.replace(/\{\{\s*unsubscribe_url\s*\}\}/gi, "");
}

// The distinct content links in a campaign body that click-tracking should
// rewrite. Runs the same sanitize + unsubscribe-strip the body itself goes
// through, so each returned `raw` href is byte-identical to what appears in the
// rendered HTML and can be used as a replacement key; `url` is its decoded, real
// destination (what the redirect lands on). Only absolute http(s) links are
// returned — relative/anchor/mailto/tel links are left untracked, and the
// footer's unsubscribe link is appended later so it never appears here.
export function extractTrackableLinks(htmlBody: string): { raw: string; url: string }[] {
  const html = stripUserUnsubscribe(sanitizeHtml(htmlBody));
  const re = /<a\b[^>]*?\shref="([^"]*)"/gi;
  const seen = new Map<string, string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const raw = m[1];
    const url = decodeHtmlEntities(raw).trim();
    if (!/^https?:\/\//i.test(url)) continue;
    if (!seen.has(raw)) seen.set(raw, url);
  }
  return [...seen].map(([raw, url]) => ({ raw, url }));
}

// Replaces each <a href="X"> whose X is a key in `map` with the mapped tracking
// URL. The tracking URLs are server-built (no quotes/brackets, single query
// param) so they drop into the double-quoted attribute as-is. Hrefs not in the
// map (relative links, the not-yet-appended unsubscribe link) are untouched.
function applyLinkTracking(html: string, map: Record<string, string>): string {
  return html.replace(
    /(<a\b[^>]*?\shref=")([^"]*)(")/gi,
    (full, pre: string, href: string, post: string) =>
      map[href] ? `${pre}${map[href]}${post}` : full,
  );
}

// Strips tags well enough for a fallback text body. Not a full HTML parser —
// campaign HTML here is simple newsletter markup.
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gis, "$2 ($1)")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function renderCampaignEmail(input: RenderInput): RenderedEmail {
  const vars: Record<string, string> = {
    first_name: input.subscriber.firstName ?? "",
    last_name: input.subscriber.lastName ?? "",
    email: input.subscriber.email,
    company_name: input.companyName,
    company_address: input.companyAddress ?? "",
    unsubscribe_url: input.unsubscribeUrl,
  };

  // Sanitize first, then strip any user-supplied unsubscribe link/placeholder so
  // the canonical footer below is the only unsubscribe link in the output. This
  // guarantees exactly one functioning unsubscribe link and protects the shared
  // sender reputation from forged/duplicate links and unsafe markup.
  // The editable footer wording. Strip any unsubscribe placeholder a user may
  // have typed so the canonical locked link below stays the only one. For HTML it
  // is escaped (it's plain wording, not markup); {{company_name}} braces survive
  // escaping and are substituted below.
  const footerIntro = stripUserUnsubscribeText(
    input.campaign.footerText?.trim() || DEFAULT_FOOTER_TEXT,
  );

  const safeHtml = sanitizeHtml(input.campaign.htmlBody);
  let html = stripUserUnsubscribe(safeHtml);

  // Rewrite content links to redirect through the click tracker BEFORE the
  // footer is appended, so the canonical unsubscribe link is never tracked.
  if (input.linkTracking) {
    html = applyLinkTracking(html, input.linkTracking);
  }

  html += `\n<hr>\n<p>${escapeHtml(footerIntro)}</p>${FOOTER_LOCKED_HTML}`;

  // Append the open-tracking pixel last, after the (trusted, server-built)
  // footer. The URL is generated by us — like unsubscribe_url — so it is not run
  // through the merge-value escaping, and it carries no {{tokens}} for substitute
  // to touch. Text bodies get no pixel (no images to load).
  if (input.openTrackingUrl) {
    html += `\n<img src="${input.openTrackingUrl}" width="1" height="1" alt="" style="display:none" />`;
  }

  const baseText = input.campaign.textBody?.trim()
    ? input.campaign.textBody
    : htmlToText(safeHtml);
  let text = stripUserUnsubscribeText(baseText);
  text += `\n\n--\n${footerIntro}\n${FOOTER_LOCKED_TEXT}`;

  return {
    // subject is plain text in the email header, not HTML — do not escape.
    subject: substituteText(input.campaign.subject, vars),
    // html substitution HTML-escapes attacker-controlled merge values (Fix 3),
    // closing the bypass where unsanitized merge vars were injected into the
    // already-sanitized body.
    html: substitute(html, vars),
    text: substituteText(text, vars),
  };
}
