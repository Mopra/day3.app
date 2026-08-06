import {
  resolveTheme,
  type CampaignTheme,
  type CampaignThemeInput,
} from "../lib/theme";

export type RenderInput = {
  campaign: {
    subject: string;
    htmlBody: string;
    textBody?: string | null;
    // Editable footer wording. Null/empty → DEFAULT_FOOTER_TEXT. The address and
    // unsubscribe link are always appended canonically regardless of this value.
    footerText?: string | null;
  };
  // The campaign's global theme (page/content background, text/heading/link colors,
  // border, corner roundness). A partial theme or null falls back to DEFAULT_THEME,
  // so callers that don't set a theme render with the clean default look.
  theme?: CampaignThemeInput | CampaignTheme | null;
  subscriber: {
    email: string;
    firstName?: string | null;
    lastName?: string | null;
    // Custom field values keyed by FormField.key, usable as {{merge_tags}}.
    attributes?: Record<string, string> | null;
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
  // Audience-level default merge values (audience_fields.fallback), keyed by
  // field key. Resolution order per token: subscriber value → inline
  // {{key|fallback}} → this map → empty. Same map for every recipient of a
  // campaign, so callers load it once per batch.
  fieldFallbacks?: Record<string, string> | null;
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

// Exported so the section serializer (lib/sections.ts) escapes image attribute
// values (src/href/alt) with the EXACT same routine the sanitizer applies, so its
// serialized <img>/<a> output is a fixed point of sanitizeHtml() — preserving the
// "what you build is what ships" invariant for image sections.
export function escapeHtml(value: string): string {
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
const TOKEN_RE = /\{\{\s*([a-z][a-z0-9_]*)\s*(?:\|\s*([^}]*))?\}\}/gi;

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

function substitute(
  template: string,
  vars: Record<string, string>,
  fieldFallbacks: Record<string, string> = {},
): string {
  return template.replace(TOKEN_RE, (_, name: string, fallback?: string) => {
    const key = name.toLowerCase();
    // A token is either a known field that's empty, or an unrecognized token
    // (typo, or a custom field this subscriber lacks). Both degrade to the
    // author-supplied inline fallback, then to the field's stored fallback
    // (audience_fields.fallback), then to empty — so {{plan|free}} works whether
    // or not the subscriber carries a `plan` attribute, and {{plan}} still
    // renders the field's default when one is configured. The stored fallback is
    // user data, so it goes through the same escaping as merge values.
    const raw = key in vars ? vars[key] : "";
    const value = raw !== "" ? raw : (fallback ?? "").trim() || (fieldFallbacks[key] ?? "");
    return key === "unsubscribe_url" ? value : escapeHtml(value);
  });
}

// Like substitute() but for the plain-text body, where HTML escaping is wrong.
function substituteText(
  template: string,
  vars: Record<string, string>,
  fieldFallbacks: Record<string, string> = {},
): string {
  return template.replace(TOKEN_RE, (_, name: string, fallback?: string) => {
    const key = name.toLowerCase();
    const raw = key in vars ? vars[key] : "";
    return raw !== "" ? raw : (fallback ?? "").trim() || (fieldFallbacks[key] ?? "");
  });
}

// Conservative allowlist for newsletter-safe markup. Anything not on this list
// is stripped (tag removed, content kept). We do NOT support arbitrary HTML:
// campaign bodies are simple newsletter content, and we share sender reputation
// across tenants, so unsafe markup is a deliverability/reputation risk.
const ALLOWED_TAGS = new Set([
  "a", "b", "blockquote", "br", "code", "div", "em", "font", "h1", "h2", "h3",
  "h4", "h5", "h6", "hr", "i", "img", "li", "ol", "p", "pre", "span", "strong",
  "table", "tbody", "td", "th", "thead", "tr", "u", "ul",
]);

// Attributes allowed per tag. Everything else (including all on* handlers, style,
// and class) is dropped. The table/td entries are presentational layout attributes
// only (column widths, vertical alignment, and color-only fills) — they carry no
// URLs, so the isSafeUrl/merge-tag guards in buildAttrs are unaffected. They exist
// so the section builder's tables (see lib/sections.ts) survive sanitization
// unchanged, keeping "what you build is exactly what ships" true for multi-column
// layouts, filled buttons, and shaded callouts. `bgcolor` (cells) and `<font color>`
// (label text) are the only color carriers, and are value-validated by isSafeColor
// in buildAttrs so they can never smuggle a CSS function or URL.
const ALLOWED_ATTRS: Record<string, Set<string>> = {
  a: new Set(["href"]),
  img: new Set(["src", "alt", "width", "height"]),
  font: new Set(["color"]),
  table: new Set(["width", "height", "role", "cellpadding", "cellspacing", "border", "align", "bgcolor", "class"]),
  td: new Set(["width", "height", "valign", "align", "bgcolor", "class"]),
  th: new Set(["width", "height", "valign", "align", "bgcolor", "class"]),
};

// Presentational class hooks the section serializer emits (lib/sections.ts) so the
// document-level <style> in wrapEmailDocument can target them: `d3-col`, the
// responsive-stacking hook on multi-column cells, and `d3-quote-round`, the hook that
// rounds a callout's corners (border-radius is forbidden inside the sanitized body, so
// like image roundness it can only ride a style-block rule keyed off this class).
// Locked to a fixed allowlist exactly like bgcolor/color: a `class` can carry no
// arbitrary value, so the serializer's output stays a fixed point of sanitizeHtml()
// (the "what you build is what ships" invariant). Any class not on the list is dropped.
// Exported so the serializer references the same string rather than a loose literal.
export const QUOTE_ROUND_CLASS = "d3-quote-round";
// The hook that rounds a CTA button's corners. Same story as the callout: border-radius
// is forbidden inside the sanitized body, so it rides a style-block rule keyed off this
// class, and the radius tracks the campaign's section roundness so a button matches the
// card and callouts.
export const BUTTON_ROUND_CLASS = "d3-btn-round";
const ALLOWED_CLASSES = new Set(["d3-col", QUOTE_ROUND_CLASS, BUTTON_ROUND_CLASS]);
export function isSafeClass(value: string): boolean {
  const tokens = value.trim().split(/\s+/).filter(Boolean);
  return tokens.length > 0 && tokens.every((c) => ALLOWED_CLASSES.has(c));
}

// Presentational colors permitted in bgcolor/color. No URLs or CSS functions —
// just a hex triplet/quad (#abc … #aabbccdd), an rgb()/rgba() with numeric
// components, or one of a small set of CSS named colors. Validated during
// sanitization so the section serializer's colored buttons/callouts round-trip as a
// fixed point of sanitizeHtml() (the "what you build is what ships" invariant).
const NAMED_COLORS = new Set([
  "transparent", "black", "white", "red", "green", "blue", "yellow", "orange",
  "purple", "pink", "gray", "grey", "silver", "gold", "cyan", "magenta", "navy",
  "teal", "maroon", "olive", "lime", "aqua", "fuchsia",
]);
export function isSafeColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3,8}$/.test(v)) return true;
  if (/^rgba?\(\s*[0-9.,%\s]+\)$/.test(v)) return true;
  return NAMED_COLORS.has(v);
}

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
// Exported so the markdown codec (lib/campaign-markdown.ts) applies the EXACT
// same scheme check when it turns `[label](url)` into an <a href>. That output is
// safe by construction and never re-sanitized (a second pass would double-escape
// `&` in URLs), so it has to make the same call the sanitizer would.
export function isSafeUrl(value: string): boolean {
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
    // Color-only attributes: drop anything that isn't a plain color token, so a
    // value can never carry a CSS function/url() into the delivered email.
    if ((name === "bgcolor" || name === "color") && !isSafeColor(value)) continue;
    // Class is allowlisted to a fixed set of server-emitted layout hooks (see
    // ALLOWED_CLASSES) — an arbitrary class never survives, so it can't be used to
    // target the document <style> in unexpected ways.
    if (name === "class" && !isSafeClass(value)) continue;
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
    // Represent images by their alt text so an image-only campaign still has a
    // meaningful plain-text part (an empty text body hurts deliverability). Runs
    // before the generic tag strip; images with no alt simply fall through to it.
    .replace(/<img\b[^>]*\balt="([^"]*)"[^>]*>/gi, (_m, alt: string) => (alt ? `${alt}\n` : ""))
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// The web-/email-safe font stack used for the message surface. A system stack so the
// email reads natively in every client without a webfont request.
const EMAIL_FONT_STACK =
  "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

// Wraps a finished (sanitized) body + footer in a complete, themed HTML email
// document: a centered ~600px content card on a colored page, with the campaign's
// theme applied via a <style> block and inline attributes. Used by the send pipeline
// and, via the same export, by the composer's preview so what you see is what ships.
//
// Theme colors/sizes come from `theme` — already validated (isThemeColor / bounded
// ints), so they're safe to interpolate into the inline styles here. The body's own
// styling stays inside its allowlisted tags; the document-level styling (page/card
// background, default text/heading/link color, image + card roundness, border) lives
// only in this wrapper, which is never run through the body sanitizer.
//
// Class hooks (`d3-body`, `d3-footer`) are added by the server (here and in the footer
// block), so the <style> can target the sanitized body by descendant tag selectors
// (`.d3-body h1`, `.d3-body a`, `.d3-body img`) even though the body carries no
// classes of its own. Outlook ignores border-radius and some properties — it falls
// back to square corners and bgcolor fills, which is acceptable graceful degradation.
export function wrapEmailDocument(inner: string, theme: CampaignTheme): string {
  const t = theme;
  const css =
    `body{margin:0;padding:0;background:${t.pageBg};}` +
    `.d3-body{color:${t.textColor};font-family:${EMAIL_FONT_STACK};font-size:16px;line-height:1.6;}` +
    `.d3-body p{margin:0 0 16px;}` +
    `.d3-body h1,.d3-body h2,.d3-body h3,.d3-body h4{color:${t.headingColor};line-height:1.25;}` +
    `.d3-body a{color:${t.linkColor};}` +
    `.d3-body img{max-width:100%;height:auto;border-radius:${t.imageRadius}px;}` +
    `.d3-body table{border-collapse:collapse;}` +
    `.d3-body td{vertical-align:top;}` +
    // Cards (image + text) opt their two cells into middle alignment so a short image
    // beside long text — or the reverse — sits balanced rather than top-stuck. This
    // attribute-scoped rule is more specific than the `.d3-body td` default above, so
    // only cells the card serializer marks `valign="middle"` center; every other cell
    // stays top-aligned. Clients that ignore <style> honor the `valign` attribute itself.
    `.d3-body td[valign="middle"]{vertical-align:middle;}` +
    // Rounded callouts (quotes the builder marks `d3-quote-round`). border-radius can't
    // ride inside the sanitized body, so — like image roundness — it lives here, keyed
    // off the class. The cell's table opts into border-collapse:separate so the radius
    // actually clips its shaded corners; the radius tracks the campaign's section
    // roundness so a callout matches the card. Outlook ignores both and shows a square
    // fill — acceptable graceful degradation, same as every other border-radius here.
    `.d3-body table.${QUOTE_ROUND_CLASS}{border-collapse:separate;border-spacing:0;}` +
    `.d3-body td.${QUOTE_ROUND_CLASS}{border-radius:${t.sectionRadius}px;}` +
    // Rounded CTA buttons. Identical mechanism to the callout above — the button's
    // table opts into border-collapse:separate so the radius clips its filled cell, and
    // the radius tracks the campaign's section roundness so a button matches the card.
    // Outlook ignores it and shows a square fill, the same graceful degradation as the
    // callout and every other border-radius in this document.
    `.d3-body table.${BUTTON_ROUND_CLASS}{border-collapse:separate;border-spacing:0;}` +
    `.d3-body td.${BUTTON_ROUND_CLASS}{border-radius:${t.sectionRadius}px;}` +
    `.d3-body hr{border:none;border-top:1px solid ${t.borderColor};margin:24px 0;}` +
    `.d3-footer{margin-top:24px;color:#8a8a8a;font-size:12px;line-height:1.5;}` +
    `.d3-footer a{color:#8a8a8a;}` +
    // Responsive stacking: below the ~600px card width, multi-column cells (marked
    // `d3-col` by the serializer) drop from side-by-side table cells to full-width
    // blocks, so 2/3-column sections, button rows, and side-by-side cards collapse
    // into a single column on phones. Stacked column images fill the new full width.
    // Clients that ignore @media (notably Outlook on desktop) keep the side-by-side
    // layout — correct, since they render at the full card width anyway.
    `@media only screen and (max-width:600px){` +
    `.d3-col{display:block!important;width:100%!important;box-sizing:border-box;}` +
    `.d3-col img{width:100%!important;height:auto!important;}` +
    `}`;
  const border = t.borderWidth > 0 ? `border:${t.borderWidth}px solid ${t.borderColor};` : "";
  return (
    `<!doctype html><html><head>` +
    `<meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${css}</style></head>` +
    `<body bgcolor="${t.pageBg}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="${t.pageBg}" style="background:${t.pageBg};">` +
    `<tbody><tr><td align="center" style="padding:24px;">` +
    `<table role="presentation" width="600" cellpadding="0" cellspacing="0" bgcolor="${t.contentBg}" ` +
    `style="width:600px;max-width:600px;background:${t.contentBg};${border}border-radius:${t.sectionRadius}px;overflow:hidden;">` +
    // Vertical-only padding here: the horizontal inset lives per-section (see
    // lib/sections.ts) so a section with a background fill can bleed to the card's
    // full width while its content stays inset. The footer is inset the same way.
    `<tbody><tr><td class="d3-body" style="padding:40px 0;color:${t.textColor};font-family:${EMAIL_FONT_STACK};font-size:16px;line-height:1.6;">` +
    inner +
    `</td></tr></tbody></table>` +
    `</td></tr></tbody></table>` +
    `</body></html>`
  );
}

export function renderCampaignEmail(input: RenderInput): RenderedEmail {
  const vars: Record<string, string> = {
    // Custom attributes first so the reserved built-ins below always win — a
    // subscriber attribute can never shadow company_name/unsubscribe_url/etc.
    ...(input.subscriber.attributes ?? {}),
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
  let body = stripUserUnsubscribe(safeHtml);

  // Rewrite content links to redirect through the click tracker BEFORE the
  // footer is appended, so the canonical unsubscribe link is never tracked.
  if (input.linkTracking) {
    body = applyLinkTracking(body, input.linkTracking);
  }

  // The footer wording + the locked address/unsubscribe lines, wrapped in a class
  // so the document's <style> can render them as the muted fine print. This block is
  // server-built (added after sanitization), so its class survives. The wrapper's
  // spacer columns inset it horizontally — the body cell now carries only vertical
  // padding (see wrapEmailDocument), so the footer (like every section) provides its
  // own 40px gutters rather than touching the card edges.
  body +=
    `\n<table role="presentation" width="100%"><tbody><tr>` +
    `<td width="40"></td>` +
    `<td><hr>\n<div class="d3-footer"><p>${escapeHtml(footerIntro)}</p>${FOOTER_LOCKED_HTML}</div></td>` +
    `<td width="40"></td>` +
    `</tr></tbody></table>`;

  // Append the open-tracking pixel last, after the (trusted, server-built)
  // footer. The URL is generated by us — like unsubscribe_url — so it is not run
  // through the merge-value escaping, and it carries no {{tokens}} for substitute
  // to touch. Text bodies get no pixel (no images to load).
  if (input.openTrackingUrl) {
    body += `\n<img src="${input.openTrackingUrl}" width="1" height="1" alt="" style="display:none" />`;
  }

  // Wrap the (sanitized) body + footer in the themed email document. The theme is
  // structured, validated data, so its values are injected into the wrapper's inline
  // styles without ever passing through the body sanitizer (which strips style).
  const html = wrapEmailDocument(body, resolveTheme(input.theme));

  const baseText = input.campaign.textBody?.trim()
    ? input.campaign.textBody
    : htmlToText(safeHtml);
  let text = stripUserUnsubscribeText(baseText);
  text += `\n\n--\n${footerIntro}\n${FOOTER_LOCKED_TEXT}`;

  const fieldFallbacks = input.fieldFallbacks ?? {};

  return {
    // subject is plain text in the email header, not HTML — do not escape.
    subject: substituteText(input.campaign.subject, vars, fieldFallbacks),
    // html substitution HTML-escapes attacker-controlled merge values (Fix 3),
    // closing the bypass where unsanitized merge vars were injected into the
    // already-sanitized body.
    html: substitute(html, vars, fieldFallbacks),
    text: substituteText(text, vars, fieldFallbacks),
  };
}
