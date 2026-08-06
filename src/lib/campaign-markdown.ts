// Day3 Markdown — the campaign body's *authoring* format.
//
// The section builder's model (lib/sections.ts) is a typed tree: exactly what the
// composer needs, and exactly what a language model writing an email in an editor
// does NOT want to emit. This module is the codec between the two, so an external
// agent (see app/api/mcp) can write an email as markdown and still get a campaign
// that opens in the builder as real, editable sections — not one opaque HTML blob.
//
// The mapping is deliberately narrow. Every construct below corresponds to one
// section kind; there is no construct that cannot round-trip:
//
//   # heading / paragraph / - list     → text
//   ![alt](url)          (alone)       → image
//   [Label](url){.button}(alone)       → button
//   ---                                → divider (rule)
//   :::spacer 48:::                    → divider (blank spacer)
//   > quote            (+ > — Name)    → quote
//   :::columns … +++ … :::             → text/image/button, 2–3 columns
//   :::card image-left … :::           → card
//   :::social Follow us: … :::         → social
//   :::section {bg=#eee} … :::         → any of the above with section styling
//   :::html … :::                      → raw allowlist-safe HTML, sanitized
//
// Two directions, two different guarantees:
//
//   markdownToSections  is safe BY CONSTRUCTION — text is escapeHtml'd and only
//     allowlisted tags are ever emitted, so its output needs no sanitize pass
//     (running one would double-escape `&` in URLs). The one exception is the
//     `:::html` passthrough, which is author-supplied and so IS sanitized.
//
//   sectionsToMarkdown is faithful for anything this dialect can express and
//     falls back to a `:::html` block for anything it can't, so the text a
//     section holds is never silently dropped. Callers that need byte-exact
//     fidelity read the `sections` array instead — the API returns both.
import {
  DEFAULT_QUOTE_BG,
  MAX_SECTIONS,
  newSectionId,
  type CampaignSection,
  type CardLayout,
  type ColumnCount,
  type SectionAlign,
  type SectionButton,
  type SectionImage,
  type SocialItem,
  type SocialNetwork,
  SOCIAL_LABELS,
} from "./sections";
import { escapeHtml, isSafeColor, isSafeUrl, sanitizeHtml } from "@/services/render";

// ---------------------------------------------------------------------------
// Shared bits
// ---------------------------------------------------------------------------

const SOCIAL_NETWORKS = Object.keys(SOCIAL_LABELS) as SocialNetwork[];

// A standalone image line: `![alt](src)`, optionally wrapped in a link.
const IMAGE_LINE_RE = /^\s*(?:\[\s*)?!\[([^\]]*)\]\(([^)\s]+)\)(?:\s*\]\(([^)\s]+)\))?\s*$/;
// A standalone button line: `[Label](href){.button …}`.
const BUTTON_LINE_RE = /^\s*\[([^\]]*)\]\(([^)\s]*)\)\s*\{\.button([^}]*)\}\s*$/;
// A fence opener: `:::name {attrs} rest`.
const FENCE_OPEN_RE = /^:::\s*([a-z]+)\s*(.*)$/i;
// The single-line spacer fence: `:::spacer 48:::`.
const SPACER_LINE_RE = /^:::\s*spacer\s*(\d*)\s*:::\s*$/i;

const isBlank = (line: string | undefined): boolean => line === undefined || !line.trim();

// `{key=value other="quoted" flag}` → a plain bag. Values may be quoted so a
// colour or a sentence with spaces survives. Bare flags map to "true".
function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-z][a-z0-9-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s}]+)))?/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    out[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? "true";
  }
  return out;
}

// Pulls a leading `{…}` group off a fence's argument string, returning the
// attributes and whatever followed them (a card layout, a social intro…).
function splitAttrs(rest: string): { attrs: Record<string, string>; text: string } {
  const m = /^\s*\{([^}]*)\}\s*(.*)$/.exec(rest);
  if (!m) return { attrs: {}, text: rest.trim() };
  return { attrs: parseAttrs(m[1]), text: m[2].trim() };
}

function safeColor(value: string | undefined): string | undefined {
  return value && isSafeColor(value) ? value.trim() : undefined;
}

function safeAlign(value: string | undefined): SectionAlign | undefined {
  return value === "left" || value === "center" || value === "right" ? value : undefined;
}

// ---------------------------------------------------------------------------
// Inline markdown → allowlist-safe HTML
// ---------------------------------------------------------------------------

// Code spans and links are lifted out before emphasis runs, so a URL containing
// `_` or `*` (very common) is never mangled into <em>.
type Shelf = string[];

function shelve(shelf: Shelf, html: string): string {
  shelf.push(html);
  return `\u0000${shelf.length - 1}\u0000`;
}

function unshelve(text: string, shelf: Shelf): string {
  // eslint-disable-next-line no-control-regex -- NUL is the sentinel, by design.
  return text.replace(/\u0000(\d+)\u0000/g, (_m, i) => shelf[Number(i)] ?? "");
}

function emphasis(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_([^_\n]+)_(?![\w])/g, "$1<em>$2</em>");
}

// One line (or run) of inline markdown → HTML. The input is escaped FIRST, so
// everything after it operates on text that can no longer introduce markup, and
// every tag below is one this module chose to emit.
function inlineToHtml(raw: string): string {
  const shelf: Shelf = [];
  let s = escapeHtml(raw);

  s = s.replace(/`([^`]+)`/g, (_m, code: string) => shelve(shelf, `<code>${code}</code>`));

  s = s.replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (match, label: string, href: string) => {
    // The href is already escapeHtml'd (the whole string was), which is exactly
    // one level of escaping — the same convention lib/sections.ts uses.
    //
    // An unsafe scheme — or a merge tag, which would become a live URL only
    // AFTER substitution, see the sanitizer's note — loses the link and keeps
    // just the label, rather than printing raw markdown at the recipient.
    if (!isSafeUrl(href) || href.includes("{{")) return shelve(shelf, emphasis(label));
    return shelve(shelf, `<a href="${href}">${emphasis(label)}</a>`);
  });

  return unshelve(emphasis(s), shelf);
}

// ---------------------------------------------------------------------------
// Block markdown → allowlist-safe HTML
// ---------------------------------------------------------------------------

// A run of markdown blocks (separated by blank lines) → the HTML that lives in
// one text column.
function markdownToHtml(markdown: string): string {
  const blocks: string[] = [];
  let buffer: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (buffer.some((l) => l.trim())) blocks.push(buffer.join("\n"));
    buffer = [];
  };

  for (const line of markdown.split("\n")) {
    const fenceMatch = /^\s*(```|~~~)/.exec(line);
    if (fenceMatch) {
      if (fence === null) {
        flush();
        fence = fenceMatch[1];
        buffer.push(line);
      } else if (line.trim().startsWith(fence)) {
        buffer.push(line);
        blocks.push(buffer.join("\n"));
        buffer = [];
        fence = null;
      } else {
        buffer.push(line);
      }
      continue;
    }
    if (fence === null && !line.trim()) {
      flush();
      continue;
    }
    // A heading ends at its newline, so it always forms a block of its own —
    // "### Title" immediately followed by prose is two blocks, not one
    // paragraph. (Markdown proper behaves the same; requiring a blank line
    // after every heading would be a trap for anyone writing these by hand.)
    if (fence === null && /^\s*#{1,6}\s+\S/.test(line)) {
      flush();
      blocks.push(line);
      continue;
    }
    buffer.push(line);
  }
  flush();

  return blocks.map(blockToHtml).join("");
}

// A column's markdown → its HTML. Runs the full node parser rather than
// markdownToHtml alone, so a `:::html` passthrough nested inside a column — what
// sectionsToMarkdown emits for content this dialect can't express — is honored
// instead of rendering as the literal text ":::html".
function columnMarkdownToHtml(markdown: string): string {
  return parseNodes(markdown)
    .map((n) => (n.type === "text" ? markdownToHtml(n.markdown) : n.type === "html" ? n.html : ""))
    .join("");
}

function blockToHtml(block: string): string {
  const raw = block.split("\n");
  if (/^\s*(?:```|~~~)/.test(raw[0] ?? "")) {
    const end = /^\s*(?:```|~~~)\s*$/.test(raw[raw.length - 1] ?? "") ? raw.length - 1 : raw.length;
    return `<pre><code>${escapeHtml(raw.slice(1, end).join("\n"))}</code></pre>`;
  }
  const lines = raw.filter((l) => l.trim());

  const heading = /^\s*(#{1,6})\s+(.*)$/.exec(lines[0] ?? "");
  if (heading && lines.length === 1) {
    const level = heading[1].length;
    return `<h${level}>${inlineToHtml(heading[2].trim())}</h${level}>`;
  }

  const bulleted = lines.length > 0 && lines.every((l) => /^\s*[-*+]\s+/.test(l));
  if (bulleted) {
    const items = lines
      .map((l) => `<li>${inlineToHtml(l.replace(/^\s*[-*+]\s+/, ""))}</li>`)
      .join("");
    return `<ul>${items}</ul>`;
  }

  const numbered = lines.length > 0 && lines.every((l) => /^\s*\d+[.)]\s+/.test(l));
  if (numbered) {
    const items = lines
      .map((l) => `<li>${inlineToHtml(l.replace(/^\s*\d+[.)]\s+/, ""))}</li>`)
      .join("");
    return `<ol>${items}</ol>`;
  }

  // A soft-wrapped paragraph: internal newlines become <br> so the author's line
  // breaks survive into the inbox.
  const html = lines.map((l) => inlineToHtml(l.trim())).join("<br>");
  return html ? `<p>${html}</p>` : "";
}

// ---------------------------------------------------------------------------
// Parsing: markdown → nodes
// ---------------------------------------------------------------------------

type ParsedImage = { image: SectionImage } | null;

function parseImageLine(line: string): ParsedImage {
  const m = IMAGE_LINE_RE.exec(line);
  if (!m) return null;
  const [, alt, src, href] = m;
  if (!isSafeUrl(src) || !/^https?:\/\//i.test(src)) return null;
  const image: SectionImage = { src };
  if (alt) image.alt = alt;
  if (href && isSafeUrl(href)) image.href = href;
  return { image };
}

function parseButtonLine(line: string): { button: SectionButton; align?: SectionAlign } | null {
  const m = BUTTON_LINE_RE.exec(line);
  if (!m) return null;
  const [, label, href, rawAttrs] = m;
  const attrs = parseAttrs(rawAttrs);
  const button: SectionButton = { label: label.trim(), href: isSafeUrl(href) ? href.trim() : "" };
  const bg = safeColor(attrs.bg);
  const text = safeColor(attrs.color ?? attrs.text);
  if (bg) button.bgColor = bg;
  if (text) button.textColor = text;
  if (attrs.full === "true" || attrs.fullwidth === "true") button.fullWidth = true;
  return { button, align: safeAlign(attrs.align) };
}

type Node =
  | { type: "text"; markdown: string }
  | { type: "break" }
  | { type: "section"; attrs: Record<string, string>; body: string }
  | { type: "divider"; line: boolean; height?: number }
  | { type: "image"; images: (SectionImage | null)[] }
  | { type: "button"; buttons: (SectionButton | null)[]; align?: SectionAlign }
  | { type: "quote"; markdown: string; attribution?: string; bgColor?: string }
  | { type: "columns"; columns: string[] }
  | { type: "card"; layout: CardLayout; image: SectionImage | null; markdown: string }
  | { type: "social"; intro?: string; items: SocialItem[] }
  | { type: "html"; html: string };

// Reads a `:::name` fence's body, consuming through its closing `:::`. Returns
// the body lines and the index just past the fence. An unclosed fence runs to
// the end of the document rather than failing — a half-written block should
// still produce something the author can see and fix in the builder.
function readFenceBody(lines: string[], start: number): { body: string[]; next: number } {
  const body: string[] = [];
  let depth = 1;
  let i = start;
  for (; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === ":::") {
      depth--;
      if (depth === 0) return { body, next: i + 1 };
    } else if (FENCE_OPEN_RE.test(line) && !SPACER_LINE_RE.test(line)) {
      // A nested block (a `:::html` passthrough inside a `:::columns` cell is
      // exactly what sectionsToMarkdown emits) must not close the outer fence.
      depth++;
    }
    body.push(line);
  }
  return { body, next: i };
}

function parseNodes(markdown: string): Node[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const nodes: Node[] = [];
  let pending: string[] = [];

  const flush = () => {
    if (pending.some((l) => l.trim())) nodes.push({ type: "text", markdown: pending.join("\n") });
    pending = [];
  };

  for (let i = 0; i < lines.length; ) {
    const line = lines[i];

    const spacer = SPACER_LINE_RE.exec(line);
    if (spacer) {
      flush();
      nodes.push({ type: "divider", line: false, height: Number(spacer[1] || 0) || undefined });
      i++;
      continue;
    }

    const fence = FENCE_OPEN_RE.exec(line);
    if (fence) {
      flush();
      const name = fence[1].toLowerCase();
      const { attrs, text } = splitAttrs(fence[2]);
      const { body, next } = readFenceBody(lines, i + 1);
      nodes.push(...fenceToNodes(name, attrs, text, body));
      i = next;
      continue;
    }

    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      flush();
      nodes.push({ type: "divider", line: true });
      i++;
      continue;
    }

    if (/^\s*={3,}\s*$/.test(line)) {
      flush();
      nodes.push({ type: "break" });
      i++;
      continue;
    }

    if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        quoted.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      // A trailing "— Name" line inside the quote is the attribution, not body.
      let attribution: string | undefined;
      const last = quoted[quoted.length - 1]?.trim();
      const attr = last ? /^(?:—|--|–)\s*(.+)$/.exec(last) : null;
      if (attr) {
        attribution = attr[1].trim();
        quoted.pop();
      }
      nodes.push({ type: "quote", markdown: quoted.join("\n").trim(), attribution });
      continue;
    }

    // A standalone image/button is one that occupies a paragraph by itself —
    // inside a sentence it stays inline markdown and renders in a text section.
    const alone = isBlank(pending[pending.length - 1]) && isBlank(lines[i + 1]);
    if (alone) {
      const img = parseImageLine(line);
      if (img) {
        flush();
        nodes.push({ type: "image", images: [img.image] });
        i++;
        continue;
      }
      const btn = parseButtonLine(line);
      if (btn) {
        flush();
        nodes.push({ type: "button", buttons: [btn.button], align: btn.align });
        i++;
        continue;
      }
    }

    pending.push(line);
    i++;
  }

  flush();
  return nodes;
}

function fenceToNodes(
  name: string,
  attrs: Record<string, string>,
  text: string,
  body: string[],
): Node[] {
  switch (name) {
    case "columns": {
      const columns: string[][] = [[]];
      for (const l of body) {
        if (/^\s*\+{3,}\s*$/.test(l)) columns.push([]);
        else columns[columns.length - 1].push(l);
      }
      return [{ type: "columns", columns: columns.map((c) => c.join("\n")) }];
    }
    case "card": {
      const layout: CardLayout =
        text === "image-right" || text === "image-top" || text === "image-left"
          ? text
          : "image-left";
      let image: SectionImage | null = null;
      const rest: string[] = [];
      for (const l of body) {
        const img: ParsedImage = image ? null : parseImageLine(l);
        if (img) image = img.image;
        else rest.push(l);
      }
      return [{ type: "card", layout, image, markdown: rest.join("\n").trim() }];
    }
    case "social": {
      const items: SocialItem[] = [];
      for (const l of body) {
        const m = /^\s*(?:[-*+]\s+)?([a-z]+)\s*:\s*(\S+)\s*$/i.exec(l);
        if (!m) continue;
        const network = m[1].toLowerCase() as SocialNetwork;
        if (!SOCIAL_NETWORKS.includes(network)) continue;
        if (!isSafeUrl(m[2])) continue;
        items.push({ network, url: m[2] });
      }
      return [{ type: "social", intro: text || undefined, items }];
    }
    case "spacer": {
      return [{ type: "divider", line: false, height: Number(text) || undefined }];
    }
    case "html": {
      return [{ type: "html", html: sanitizeHtml(body.join("\n")) }];
    }
    case "quote": {
      return [
        {
          type: "quote",
          markdown: body.join("\n").trim(),
          attribution: attrs.by,
          bgColor: safeColor(attrs.bg),
        },
      ];
    }
    case "section":
    default:
      return [{ type: "section", attrs, body: body.join("\n") }];
  }
}

// ---------------------------------------------------------------------------
// Nodes → sections
// ---------------------------------------------------------------------------

function clampColumns(n: number): ColumnCount {
  return n >= 3 ? 3 : n === 2 ? 2 : 1;
}

// A `:::columns` block becomes an *image* or *button* section when every column
// holds exactly one of those and nothing else — matching the builder, where the
// kind belongs to the section rather than the cell. Anything else is text.
function columnsToSection(columns: string[]): CampaignSection {
  const count = clampColumns(columns.length);
  const cells = columns.slice(0, count);
  while (cells.length < count) cells.push("");
  const trimmed = cells.map((c) => c.trim());

  const images = trimmed.map((c) => parseImageLine(c)?.image ?? null);
  if (trimmed.every((c) => c) && images.every((img) => img)) {
    return {
      id: newSectionId(),
      columns: count,
      kind: "image",
      content: cells.map(() => ""),
      images,
    };
  }

  const buttons = trimmed.map((c) => parseButtonLine(c));
  if (trimmed.every((c) => c) && buttons.every((b) => b)) {
    return {
      id: newSectionId(),
      columns: count,
      kind: "button",
      content: cells.map(() => ""),
      buttons: buttons.map((b) => b!.button),
      align: buttons[0]?.align ?? "center",
    };
  }

  return {
    id: newSectionId(),
    columns: count,
    kind: "text",
    content: cells.map((c) => columnMarkdownToHtml(c)),
  };
}

function nodeToSection(node: Node): CampaignSection | null {
  switch (node.type) {
    case "text": {
      const html = markdownToHtml(node.markdown);
      return html
        ? { id: newSectionId(), columns: 1, kind: "text", content: [html] }
        : null;
    }
    case "html":
      return node.html.trim()
        ? { id: newSectionId(), columns: 1, kind: "text", content: [node.html] }
        : null;
    case "divider":
      return {
        id: newSectionId(),
        columns: 1,
        kind: "divider",
        content: [""],
        line: node.line,
        ...(node.height ? { height: node.height } : {}),
      };
    case "image":
      return {
        id: newSectionId(),
        columns: clampColumns(node.images.length),
        kind: "image",
        content: node.images.map(() => ""),
        images: node.images,
      };
    case "button":
      return {
        id: newSectionId(),
        columns: clampColumns(node.buttons.length),
        kind: "button",
        content: node.buttons.map(() => ""),
        buttons: node.buttons,
        align: node.align ?? "center",
      };
    case "quote":
      return {
        id: newSectionId(),
        columns: 1,
        kind: "quote",
        content: [columnMarkdownToHtml(node.markdown)],
        bgColor: node.bgColor ?? DEFAULT_QUOTE_BG,
        rounded: true,
        ...(node.attribution ? { attribution: node.attribution } : {}),
      };
    case "columns":
      return columnsToSection(node.columns);
    case "card":
      return {
        id: newSectionId(),
        columns: 1,
        kind: "card",
        content: [columnMarkdownToHtml(node.markdown)],
        images: [node.image],
        layout: node.layout,
      };
    case "social":
      return node.items.length
        ? {
            id: newSectionId(),
            columns: 1,
            kind: "social",
            content: [""],
            socials: node.items,
            socialIntro: node.intro,
            align: "center",
          }
        : null;
    case "section":
    case "break":
      return null;
  }
}

/**
 * Day3 Markdown → the section builder's model.
 *
 * Consecutive prose blocks fold into a single text section (the way a person
 * uses the builder — one block holds several paragraphs); a `===` line forces a
 * split where the author wants two. Output is capped at MAX_SECTIONS so a
 * runaway document is truncated rather than rejected.
 */
export function markdownToSections(markdown: string): CampaignSection[] {
  return nodesToSections(parseNodes(markdown));
}

function nodesToSections(nodes: Node[]): CampaignSection[] {
  const sections: CampaignSection[] = [];
  let run: string[] = [];

  const flushRun = () => {
    if (!run.some((m) => m.trim())) {
      run = [];
      return;
    }
    const html = markdownToHtml(run.join("\n\n"));
    if (html) sections.push({ id: newSectionId(), columns: 1, kind: "text", content: [html] });
    run = [];
  };

  for (const node of nodes) {
    if (node.type === "text") {
      run.push(node.markdown);
      continue;
    }
    flushRun();
    if (node.type === "break") continue;
    if (node.type === "section") {
      // A styling wrapper: parse its body normally, then stamp the background /
      // alignment onto every section it produced.
      const inner = nodesToSections(parseNodes(node.body));
      const bg = safeColor(node.attrs.bg ?? node.attrs.background);
      const align = safeAlign(node.attrs.align);
      for (const s of inner) {
        if (bg) s.sectionBg = bg;
        if (align) s.align = align;
        sections.push(s);
      }
      continue;
    }
    const section = nodeToSection(node);
    if (section) sections.push(section);
  }
  flushRun();

  return sections.slice(0, MAX_SECTIONS);
}

// ---------------------------------------------------------------------------
// HTML → markdown (the reverse direction)
// ---------------------------------------------------------------------------

// Tags this converter knows how to express as markdown. Column HTML using
// anything else (a <font>, a <table>, a nested list) is emitted verbatim inside
// a `:::html` fence instead of being flattened, so no content is ever lost.
const REPRESENTABLE = new Set([
  "p", "br", "strong", "b", "em", "i", "code", "a", "ul", "ol", "li",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre",
]);

function isRepresentable(html: string): boolean {
  const tags = html.matchAll(/<\s*\/?\s*([a-z][a-z0-9]*)/gi);
  for (const t of tags) {
    if (!REPRESENTABLE.has(t[1].toLowerCase())) return false;
  }
  // Nested lists have no single-line representation in this dialect.
  return !/<li>[\s\S]*?<(?:ul|ol)\b/i.test(html);
}

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function inlineToMarkdown(html: string): string {
  return decodeEntities(
    html
      .replace(/<\s*(?:strong|b)\s*>([\s\S]*?)<\s*\/\s*(?:strong|b)\s*>/gi, "**$1**")
      .replace(/<\s*(?:em|i)\s*>([\s\S]*?)<\s*\/\s*(?:em|i)\s*>/gi, "*$1*")
      .replace(/<\s*code\s*>([\s\S]*?)<\s*\/\s*code\s*>/gi, "`$1`")
      .replace(/<\s*a\b[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\s*\/\s*a\s*>/gi, "[$2]($1)")
      .replace(/<\s*br\s*\/?\s*>/gi, "\n")
      .replace(/<[^>]+>/g, ""),
  ).trim();
}

// One text column's HTML → markdown. Returns null when the content can't be
// represented, so the caller can fall back to a `:::html` passthrough.
function htmlToMarkdown(html: string): string | null {
  if (!isRepresentable(html)) return null;
  const out: string[] = [];
  const blockRe =
    /<\s*(h[1-6]|p|ul|ol|blockquote|pre)\b[^>]*>([\s\S]*?)<\s*\/\s*\1\s*>/gi;
  let lastEnd = 0;
  let m: RegExpExecArray | null;

  while ((m = blockRe.exec(html)) !== null) {
    // Text sitting between blocks (Tiptap shouldn't emit any, but a hand-edited
    // body might) is kept as its own paragraph rather than dropped.
    const between = inlineToMarkdown(html.slice(lastEnd, m.index));
    if (between) out.push(between);
    lastEnd = m.index + m[0].length;

    const tag = m[1].toLowerCase();
    const inner = m[2];
    if (/^h[1-6]$/.test(tag)) {
      out.push(`${"#".repeat(Number(tag[1]))} ${inlineToMarkdown(inner)}`);
    } else if (tag === "ul" || tag === "ol") {
      const items = [...inner.matchAll(/<\s*li\s*>([\s\S]*?)<\s*\/\s*li\s*>/gi)];
      out.push(
        items
          .map((li, idx) =>
            tag === "ul" ? `- ${inlineToMarkdown(li[1])}` : `${idx + 1}. ${inlineToMarkdown(li[1])}`,
          )
          .join("\n"),
      );
    } else if (tag === "blockquote") {
      out.push(
        inlineToMarkdown(inner)
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n"),
      );
    } else if (tag === "pre") {
      const code = /<\s*code\s*>([\s\S]*?)<\s*\/\s*code\s*>/i.exec(inner);
      out.push("```\n" + decodeEntities(code ? code[1] : inner.replace(/<[^>]+>/g, "")) + "\n```");
    } else {
      const text = inlineToMarkdown(inner);
      if (text) out.push(text);
    }
  }

  const tail = inlineToMarkdown(html.slice(lastEnd));
  if (tail) out.push(tail);
  return out.join("\n\n");
}

// A column's HTML → markdown, or a `:::html` fence when it can't be expressed.
function columnToMarkdown(html: string): string {
  if (!html.trim()) return "";
  const md = htmlToMarkdown(html);
  return md === null ? `:::html\n${html.trim()}\n:::` : md;
}

// ---------------------------------------------------------------------------
// Sections → markdown
// ---------------------------------------------------------------------------

function imageToMarkdown(image: SectionImage | null | undefined): string {
  if (!image?.src) return "";
  const base = `![${image.alt ?? ""}](${image.src})`;
  return image.href ? `[${base}](${image.href})` : base;
}

function buttonToMarkdown(button: SectionButton | null | undefined, align?: SectionAlign): string {
  if (!button) return "";
  const attrs = [".button"];
  if (button.bgColor) attrs.push(`bg=${button.bgColor}`);
  if (button.textColor) attrs.push(`color=${button.textColor}`);
  if (button.fullWidth) attrs.push("full");
  if (align && align !== "center") attrs.push(`align=${align}`);
  return `[${button.label}](${button.href}){${attrs.join(" ")}}`;
}

function sectionToMarkdown(section: CampaignSection): string {
  switch (section.kind) {
    case "divider":
      return section.line === false
        ? `:::spacer ${section.height ?? ""}:::`.replace(/\s+:::$/, ":::")
        : "---";
    case "image": {
      const parts = (section.images ?? []).map(imageToMarkdown);
      if (section.columns === 1) return parts[0] ?? "";
      return `:::columns\n${parts.join("\n+++\n")}\n:::`;
    }
    case "button": {
      const parts = (section.buttons ?? []).map((b) => buttonToMarkdown(b, section.align));
      if (section.columns === 1) return parts[0] ?? "";
      return `:::columns\n${parts.join("\n+++\n")}\n:::`;
    }
    case "quote": {
      const body = columnToMarkdown(section.content[0] ?? "");
      const lines = body.split("\n").map((l) => `> ${l}`.trimEnd());
      if (section.attribution) lines.push(`> — ${section.attribution}`);
      return lines.join("\n");
    }
    case "social": {
      const intro = section.socialIntro ? ` ${section.socialIntro}` : "";
      const items = (section.socials ?? []).map((s) => `- ${s.network}: ${s.url}`);
      return `:::social${intro}\n${items.join("\n")}\n:::`;
    }
    case "card": {
      const img = imageToMarkdown(section.images?.[0]);
      const text = columnToMarkdown(section.content[0] ?? "");
      return `:::card ${section.layout ?? "image-left"}\n${[img, text].filter(Boolean).join("\n\n")}\n:::`;
    }
    case "text":
    default: {
      if (section.columns === 1) return columnToMarkdown(section.content[0] ?? "");
      const parts = section.content.map(columnToMarkdown);
      return `:::columns\n${parts.join("\n+++\n")}\n:::`;
    }
  }
}

/**
 * The section builder's model → Day3 Markdown.
 *
 * A section carrying styling this dialect only expresses as a wrapper (a
 * background fill, a non-default alignment on prose) is emitted inside a
 * `:::section {…}` block so the styling survives a markdown round-trip.
 * Adjacent plain-text sections are separated by `===` so the split between them
 * isn't silently merged when the markdown is parsed back.
 */
export function sectionsToMarkdown(sections: CampaignSection[]): string {
  const parts: string[] = [];

  sections.forEach((section, index) => {
    let md = sectionToMarkdown(section);
    if (!md.trim()) return;

    const attrs: string[] = [];
    if (section.sectionBg && section.sectionBg !== "transparent") {
      attrs.push(`bg=${section.sectionBg}`);
    }
    // Alignment rides the section wrapper only where it isn't already part of
    // the construct's own syntax (buttons carry theirs in `{.button align=…}`).
    if (section.align && section.align !== "left" && (section.kind === "text" || section.kind === "quote")) {
      attrs.push(`align=${section.align}`);
    }
    if (attrs.length) md = `:::section {${attrs.join(" ")}}\n${md}\n:::`;

    // Two plain-text sections in a row would fold back into one on re-parse.
    const prev = sections[index - 1];
    if (prev && prev.kind === "text" && section.kind === "text" && !attrs.length && parts.length) {
      parts.push("===");
    }
    parts.push(md);
  });

  return parts.join("\n\n");
}
