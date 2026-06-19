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

function substitute(template: string, vars: Record<string, string>): string {
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

// URL schemes we permit in href/src. Blocks javascript:, data:, vbscript:, etc.
// Protocol-relative ("//host") and relative URLs are allowed.
function isSafeUrl(value: string): boolean {
  const trimmed = value.trim();
  // eslint-disable-next-line no-control-regex
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(trimmed.replace(/[\x00-\x20]/g, ""));
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
    if ((name === "href" || name === "src") && !isSafeUrl(value)) continue;
    out += ` ${name}="${value.replace(/"/g, "&quot;")}"`;
  }
  return out;
}

// Minimal HTML sanitizer: drops disallowed tags (keeping their text content),
// removes the contents of dangerous tags entirely (<script>/<style>/<iframe>),
// and filters attributes against the allowlist. Not a full DOM parser — it
// matches the lightweight, dependency-free approach used by htmlToText below.
export function sanitizeHtml(html: string): string {
  // Drop comments and the entire contents of script-like/style/embed tags.
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*?<\/\1\s*>/gi, "")
    // Unclosed dangerous tags: strip from the opening tag to end of input.
    .replace(/<(script|style|iframe|object|embed|noscript|template)\b[\s\S]*$/gi, "");

  return cleaned.replace(
    /<\s*(\/?)([a-z][a-z0-9]*)\b([^>]*)>/gi,
    (_match, slash: string, name: string, rawAttrs: string) => {
      const tag = name.toLowerCase();
      if (!ALLOWED_TAGS.has(tag)) return "";
      if (slash) return `</${tag}>`;
      return `<${tag}${buildAttrs(tag, rawAttrs)}>`;
    },
  );
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
    subject: substitute(input.campaign.subject, vars),
    html: substitute(html, vars),
    text: substitute(text, vars),
  };
}
