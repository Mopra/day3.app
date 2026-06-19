export type RenderInput = {
  campaign: {
    subject: string;
    htmlBody: string;
    textBody?: string | null;
  };
  subscriber: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
  };
  companyName: string;
  companyAddress?: string | null;
  unsubscribeUrl: string;
};

export type RenderedEmail = {
  subject: string;
  html: string;
  text: string;
};

const FOOTER_HTML = `
<hr>
<p>You are receiving this email because you subscribed to updates from {{company_name}}.</p>
<p>{{company_address}}</p>
<p><a href="{{unsubscribe_url}}">Unsubscribe</a></p>
`;

const FOOTER_TEXT = `

--
You are receiving this email because you subscribed to updates from {{company_name}}.
{{company_address}}
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
function substitute(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, name: string) => {
    const key = name.toLowerCase();
    if (!(key in vars)) return "";
    const value = vars[key];
    return key === "unsubscribe_url" ? value : escapeHtml(value);
  });
}

// Like substitute() but for the plain-text body, where HTML escaping is wrong.
function substituteText(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi, (_, name: string) => {
    const key = name.toLowerCase();
    return key in vars ? vars[key] : "";
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
  const safeHtml = sanitizeHtml(input.campaign.htmlBody);
  let html = stripUserUnsubscribe(safeHtml);
  html += FOOTER_HTML;

  const baseText = input.campaign.textBody?.trim()
    ? input.campaign.textBody
    : htmlToText(safeHtml);
  let text = stripUserUnsubscribeText(baseText);
  text += FOOTER_TEXT;

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
