// The campaign body's edit-time model. The body is an ordered list of *sections*,
// each laid out as 1, 2, or 3 equal-width columns. A section has a *kind*:
//   - text    — rich content per column
//   - image   — one uploaded image per column that fills the column
//   - button  — one call-to-action button per column (a "button row" for 2/3 cols)
//   - divider — a horizontal rule, or a fixed vertical spacer
//   - quote   — a shaded callout box of rich text with an optional attribution
//   - social  — a centered row of links to the org's social profiles
//   - card    — one image paired with rich text (image left / right / on top)
// This module is framework-agnostic (no React) so it can run in the composer, the
// API routes, and tests alike.
//
// `htmlBody` remains the canonical, serialized output that the whole send pipeline
// consumes unchanged (services/render.ts, click-tracking, previews). Sections are
// serialized to *email-safe layout tables* — text columns come from the
// allowlist-locked Tiptap editor, and image cells are emitted with their attribute
// values escaped by the sanitizer's own escapeHtml — so the serialized output is,
// by construction, a no-op under sanitizeHtml(). That invariant ("what the builder
// produces is exactly what ships, and it is always email-safe") is covered by a test.
import { z } from "zod";
import { escapeHtml, isSafeColor, BUTTON_ROUND_CLASS, QUOTE_ROUND_CLASS } from "@/services/render";

export type ColumnCount = 1 | 2 | 3;

// A section's kind is chosen per section, not per column. Legacy sections (stored
// before kinds existed) have no `kind` and are read as text. Only text/image/button
// use the 1/2/3 column picker; the rest are single-column (the picker is hidden).
export type SectionKind = "text" | "image" | "button" | "divider" | "quote" | "social" | "card";

// Horizontal alignment for a button row / social row / card image.
export type SectionAlign = "left" | "center" | "right";

// One call-to-action button occupying a column of a button section. `bgColor` fills
// the button; `textColor` is the label color (emitted via <font> so it survives our
// style-free sanitizer). Both fall back to the brand defaults below. `href` is the
// click-through; a button with no href/label serializes to nothing.
export type SectionButton = {
  label: string;
  href: string;
  bgColor?: string;
  textColor?: string;
  // When true the button stretches to fill its column's full width (a prominent CTA
  // bar); unset/false is the default, where the button hugs its label.
  fullWidth?: boolean;
};

// The social networks a social-links row can point at. `website`/`email` cover the
// common "and our site / drop us a line" cases.
export type SocialNetwork =
  | "twitter"
  | "linkedin"
  | "facebook"
  | "instagram"
  | "youtube"
  | "github"
  | "website"
  | "email";

// One profile link in a social section. `url` is the full destination (https for
// profiles, or a mailto: for `email`).
export type SocialItem = { network: SocialNetwork; url: string };

// How a card lays its single image relative to its rich text.
export type CardLayout = "image-left" | "image-right" | "image-top";

// Brand-ish defaults so a freshly added button/callout already looks intentional.
export const DEFAULT_BUTTON_BG = "#2563eb";
export const DEFAULT_BUTTON_TEXT = "#ffffff";
export const DEFAULT_QUOTE_BG = "#f4f4f5";
// Bounds for a divider's spacer height (px).
export const MIN_SPACER_HEIGHT = 8;
export const MAX_SPACER_HEIGHT = 200;
export const DEFAULT_SPACER_HEIGHT = 32;

// Human label per network, used both in the editor and as the link text/alt.
export const SOCIAL_LABELS: Record<SocialNetwork, string> = {
  twitter: "Twitter",
  linkedin: "LinkedIn",
  facebook: "Facebook",
  instagram: "Instagram",
  youtube: "YouTube",
  github: "GitHub",
  website: "Website",
  email: "Email",
};

// One uploaded image occupying a column of an image section. `src` is an absolute
// public URL (our campaign-assets bucket) — the exact bytes the email embeds. The
// image always fills its column. When the section has an explicit `height`, the
// image is *cover-cropped* to the column box and `src` points at that cropped
// upload, while `originalSrc` keeps the full upload so re-dragging the height (or
// changing the column count) can re-crop from the original instead of degrading.
// `width`/`height` are the rendered box dimensions (natural dimensions when the
// section height is unset), used to emit width/height attributes so clients don't
// reflow/distort. `href` is an optional click-through that wraps the image in a link.
export type SectionImage = {
  src: string;
  originalSrc?: string;
  alt?: string;
  href?: string;
  width?: number;
  height?: number;
};

export type CampaignSection = {
  // Stable id — used as the React key and the drag-and-drop sortable id, so it must
  // survive content/column edits and reorders.
  id: string;
  columns: ColumnCount;
  // The section kind. Filled in as "text" for legacy rows on parse.
  kind: SectionKind;
  // One HTML string per column. Always `content.length === columns`. Each entry is
  // allowlist-safe Tiptap output (empty columns are ""). Used when kind === "text";
  // for kind "quote"/"card" the rich text lives in `content[0]`. Kept sized to
  // `columns` even for other kinds so toggling kind never drops written text.
  content: string[];
  // One image (or null = empty slot) per column when kind === "image", or a single
  // image in `images[0]` for a "card". Sized to `columns` for image sections.
  images?: (SectionImage | null)[];
  // Explicit rendered height (px). For an image section it's the cover-crop box the
  // images fill; for a "divider" spacer it's the vertical gap. Unset = natural.
  height?: number;
  // One button (or null = empty slot) per column when kind === "button". Sized to
  // `columns`.
  buttons?: (SectionButton | null)[];
  // Horizontal alignment of a button row / social row / card image. Defaults vary by
  // kind (buttons + social center; a card image hugs its side).
  align?: SectionAlign;
  // kind === "quote": the callout's background fill, and an optional attribution
  // line ("— Jane, Acme") shown beneath the quote.
  bgColor?: string;
  attribution?: string;
  // kind === "quote": whether the callout's corners are rounded (to the campaign's
  // section roundness, applied at render time). Absent = square corners; set
  // explicitly when a quote is created so the builder and email always agree.
  rounded?: boolean;
  // Any kind: an optional background color filling the whole section block. Unset (or
  // "transparent") means the section sits directly on the content background, exactly
  // as before per-section backgrounds existed. Distinct from a quote's `bgColor`,
  // which tints only the inset callout box.
  sectionBg?: string;
  // kind === "social": the profile links, in display order, plus optional lead-in
  // text ("Follow us:").
  socials?: SocialItem[];
  socialIntro?: string;
  // kind === "divider": true (or absent) = a horizontal rule; false = a blank spacer
  // sized by `height`.
  line?: boolean;
  // kind === "card": how the image sits relative to the text.
  layout?: CardLayout;
};

// Generous caps. The API additionally guards the *serialized* body against the
// existing 500 KB htmlBody limit (see app/api/campaigns), so these only bound a
// single field / the section count.
export const MAX_COLUMN_CHARS = 100_000;
export const MAX_SECTIONS = 30;
// Sanity ceiling for stored natural image dimensions (px). Only affects the
// width/height attributes we emit; not a quality constraint.
export const MAX_IMAGE_DIMENSION = 10_000;

// Equal-width columns. A lone column fills the table (no explicit width); 2 and 3
// columns split evenly. Email clients distribute any rounding remainder across the
// row, so exact thirds aren't needed.
const COLUMN_WIDTHS: Record<ColumnCount, (string | null)[]> = {
  1: [null],
  2: ["50%", "50%"],
  3: ["33%", "33%", "33%"],
};

// The pixel width a single column occupies inside a typical ~600px email body.
// Used to size full-bleed images per column (1 col → 600, halves → 300, thirds →
// 200). Approximate by design — email clients reflow — but enough to stop Outlook
// rendering an image at its full natural width and blowing out the layout. Exported
// so the editor crops uploaded images to the exact same box the email will use.
const COLUMN_PIXEL_WIDTHS: Record<ColumnCount, number> = { 1: 600, 2: 300, 3: 200 };
export function columnPixelWidth(columns: ColumnCount): number {
  return COLUMN_PIXEL_WIDTHS[columns];
}

export function newSectionId(): string {
  return `sec_${crypto.randomUUID()}`;
}

// A blank (text) section with the requested number of empty columns.
export function emptySection(columns: ColumnCount = 1): CampaignSection {
  return {
    id: newSectionId(),
    columns,
    kind: "text",
    content: Array.from({ length: columns }, () => ""),
  };
}

// A deep copy of a section with a *fresh* id, so the original and the copy stay
// independent React keys / sortable ids. Used by the builder's "duplicate" action.
export function duplicateSection(section: CampaignSection): CampaignSection {
  return {
    ...section,
    id: newSectionId(),
    content: [...section.content],
    images: section.images ? section.images.map((img) => (img ? { ...img } : null)) : undefined,
    buttons: section.buttons ? section.buttons.map((b) => (b ? { ...b } : null)) : undefined,
    socials: section.socials ? section.socials.map((s) => ({ ...s })) : undefined,
  };
}

// Switches a section to another kind, initializing the target kind's fields while
// preserving every other field, so flipping between kinds never loses written text,
// an uploaded image, or a button a user already configured. Only text/image/button
// keep the multi-column layout; the rest collapse to a single column (their editors
// hide the column picker).
export function setSectionKind(section: CampaignSection, kind: SectionKind): CampaignSection {
  if (section.kind === kind) return section;
  // Only text/image/button keep the multi-column layout; the rest collapse to a
  // single column. Collapsing reuses resizeSection so the dropped columns' text is
  // folded into content[0] (kept sized to columns) rather than orphaned — which also
  // keeps the schema's content.length === columns invariant true.
  const multiColumn = kind === "text" || kind === "image" || kind === "button";
  const s = multiColumn || section.columns === 1 ? section : resizeSection(section, 1);
  const base = { ...s, kind };
  switch (kind) {
    case "image": {
      const images = Array.from({ length: s.columns }, (_, i) => s.images?.[i] ?? null);
      return { ...base, images };
    }
    case "button": {
      const buttons = Array.from({ length: s.columns }, (_, i) => s.buttons?.[i] ?? null);
      return { ...base, buttons, align: s.align ?? "center" };
    }
    case "divider":
      return { ...base, line: s.line ?? true, height: s.height ?? DEFAULT_SPACER_HEIGHT };
    case "quote":
      // New callouts default to rounded (matching the campaign roundness); a value the
      // user already chose is preserved across kind flips.
      return { ...base, bgColor: s.bgColor ?? DEFAULT_QUOTE_BG, rounded: s.rounded ?? true };
    case "social":
      return { ...base, socials: s.socials ?? [], align: s.align ?? "center" };
    case "card":
      return { ...base, layout: s.layout ?? "image-left", images: [s.images?.[0] ?? null] };
    case "text":
    default:
      return base;
  }
}

// Resizes a section to a new column count without losing work: growing appends
// empty columns; shrinking folds the dropped columns' non-empty *text* into the
// last column that survives. Images can't be folded into one cell, so an image
// section just appends empty slots on grow and drops the overflow images on shrink.
export function resizeSection(section: CampaignSection, columns: ColumnCount): CampaignSection {
  if (columns === section.columns) return section;
  let content: string[];
  if (columns > section.columns) {
    content = [...section.content];
    while (content.length < columns) content.push("");
  } else {
    const kept = section.content.slice(0, columns);
    const overflow = section.content.slice(columns).filter((c) => c.trim());
    if (overflow.length) {
      kept[columns - 1] = [kept[columns - 1], ...overflow].filter((c) => c.trim()).join("\n");
    }
    content = kept;
  }
  const grow = <T>(arr: T[] | undefined, fill: T): T[] | undefined => {
    if (!arr) return arr;
    if (columns > section.columns) {
      const next = [...arr];
      while (next.length < columns) next.push(fill);
      return next;
    }
    return arr.slice(0, columns);
  };
  return {
    ...section,
    columns,
    content,
    images: grow(section.images, null),
    buttons: grow(section.buttons, null),
  };
}

// Whether a section carries anything worth shipping. Used only for the whole-body
// emptiness gate (see serializeSections) — a divider returns false so a body that is
// *only* a divider still reads as empty (a lone rule isn't a real email), even
// though a divider is serialized normally once some other section has content.
function sectionHasContent(section: CampaignSection): boolean {
  switch (section.kind) {
    case "image":
      return (section.images ?? []).some((img) => !!img?.src);
    case "button":
      return (section.buttons ?? []).some((b) => !!b?.label.trim() && !!b?.href.trim());
    case "quote":
      return !!section.content[0]?.trim();
    case "social":
      return (section.socials ?? []).some((s) => !!s.url.trim());
    case "card":
      return !!section.images?.[0]?.src || !!section.content[0]?.trim();
    case "divider":
      return false;
    case "text":
    default:
      return section.content.some((c) => c.trim());
  }
}

// True only for a color value the sanitizer's isSafeColor will also accept, so the
// serializer never emits a color that sanitizeHtml would strip (which would break
// the round-trip invariant). Falls back to `fallback` otherwise.
function pickColor(value: string | undefined, fallback: string): string {
  return value && isSafeColor(value) ? value.trim() : fallback;
}

// Emits one image cell: an <img> that fills the column, optionally wrapped in an
// <a href>. When the section has an explicit `height`, `src` is already cover-
// cropped to the column box, so we emit those exact box dimensions. Otherwise the
// image keeps its natural aspect, scaled to the column's pixel budget and never
// upscaled. Every attribute value is escaped with the sanitizer's own escapeHtml so
// the result is a fixed point of sanitizeHtml() (the email-safe invariant). An
// empty slot serializes to nothing.
function serializeImageCell(
  image: SectionImage | null | undefined,
  columnWidth: number,
  sectionHeight?: number,
): string {
  if (!image?.src) return "";
  let width: number;
  let height: number | undefined;
  if (sectionHeight) {
    width = columnWidth;
    height = sectionHeight;
  } else {
    width = image.width && image.width < columnWidth ? image.width : columnWidth;
    height =
      image.width && image.height ? Math.round(width * (image.height / image.width)) : undefined;
  }
  const dims = ` width="${width}"` + (height ? ` height="${height}"` : "");
  const img = `<img src="${escapeHtml(image.src)}" alt="${escapeHtml(image.alt ?? "")}"${dims}>`;
  return image.href ? `<a href="${escapeHtml(image.href)}">${img}</a>` : img;
}

// Serializes the section list to email-safe HTML for `htmlBody`. Each section is a
// presentation table whose cells carry only width/valign — attributes the sanitizer
// allowlists (no inline styles or classes). Text column HTML is placed verbatim
// (already allowlist-safe); image cells are built by serializeImageCell.
//
// Returns "" when nothing has been written anywhere, so the body's emptiness stays
// detectable via `htmlBody.trim()` — the signal the autosave "worth saving" check,
// the Preview gate, and the server-side send check (campaignContentError) all rely
// on. (An all-empty grid of tables would otherwise read as "has content".)
export function serializeSections(sections: CampaignSection[]): string {
  if (!sections.some(sectionHasContent)) return "";
  // Drop sections that serialize to nothing (an empty social/card section, a button
  // with no link) so the inter-section spacer never lands beside a blank and doubles
  // the gap. Surviving sections are then separated by a single spacer — mirroring the
  // builder's `space-y` (spacing *between* sections only; the 40px top/bottom padding
  // on the document wrapper's body cell already handles the first/last edge).
  const parts = sections.map(serializeSection).filter((part) => part !== "");
  return parts.join(`\n${SECTION_SPACER}\n`);
}

// Vertical gap (px) inserted between adjacent sections so the delivered email keeps
// the same rhythm as the builder's live canvas, where sections are separated by
// `space-y-2` plus each section's `py-1` (~16px total). Without it, sections whose
// content carries no margins of its own — a button, an image, a divider — butt flush
// against their neighbors in the inbox, unlike the canvas.
const SECTION_SPACING = 16;

// An email-safe spacer row: a height-only cell carrying a non-breaking space so
// clients don't collapse the empty row (the same shape as a divider spacer). Uses
// only allowlisted attributes, so it stays a fixed point of sanitizeHtml() like the
// rest of the serialized output.
const SECTION_SPACER = `<table role="presentation" width="100%"><tbody><tr><td height="${SECTION_SPACING}">&nbsp;</td></tr></tbody></table>`;

// One section → its email-safe table(s), wrapped in its layout band (horizontal
// gutters, plus a full-width background fill when one is set).
function serializeSection(section: CampaignSection): string {
  return wrapSectionLayout(serializeSectionBody(section), section.sectionBg);
}

// The section's body markup, before any background wrapper. Text/image/button share
// the column-table layout (their cells differ); the other kinds have their own
// bespoke table.
function serializeSectionBody(section: CampaignSection): string {
  switch (section.kind) {
    case "divider":
      return serializeDivider(section);
    case "quote":
      return serializeQuote(section);
    case "social":
      return serializeSocial(section);
    case "card":
      return serializeCard(section);
    case "text":
    case "image":
    case "button":
    default:
      return serializeColumns(section);
  }
}

// Horizontal gutter (px) insetting a section's content from the content card's edges.
// The email-document wrapper's body cell carries no horizontal padding (see
// services/render.ts wrapEmailDocument) — the inset lives here, per-section, which is
// exactly what lets a section with a background fill bleed to the card's full width
// while its content stays inset. Matches the composer canvas's content padding so the
// live editor and the delivered email line up.
const SECTION_GUTTER = 40;

// Wraps a section's body in its layout band. A colored section becomes a full-bleed,
// color-filled table spanning the card's full width, its content inset on all sides by
// cellpadding. An uncolored section gets transparent spacer columns that inset the
// content horizontally only — adding no vertical space, so uncolored sections keep
// their previous rhythm. Returns the body unchanged when it's empty (an empty section
// serializes to nothing, colored or not).
function wrapSectionLayout(body: string, bg: string | undefined): string {
  if (!body) return body;
  const color = bg && bg !== "transparent" && isSafeColor(bg) ? bg.trim() : null;
  if (color) {
    return (
      `<table role="presentation" width="100%" cellpadding="${SECTION_GUTTER}" bgcolor="${color}"><tbody><tr>` +
      `<td bgcolor="${color}">${body}</td>` +
      `</tr></tbody></table>`
    );
  }
  return (
    `<table role="presentation" width="100%"><tbody><tr>` +
    `<td width="${SECTION_GUTTER}"></td>` +
    `<td>${body}</td>` +
    `<td width="${SECTION_GUTTER}"></td>` +
    `</tr></tbody></table>`
  );
}

// The shared 1/2/3-column table used by text, image, and button sections. Each
// cell's inner content is built per kind; everything else (equal widths, valign) is
// identical, so multi-column layouts stay byte-identical to what the old code emit.
function serializeColumns(section: CampaignSection): string {
  const widths = COLUMN_WIDTHS[section.columns];
  const pixelWidth = COLUMN_PIXEL_WIDTHS[section.columns];
  // Multi-column cells carry the `d3-col` hook so the email document's <style> can
  // stack them to full width on phones (see wrapEmailDocument's @media rule). A lone
  // column already fills the row, so it gets no hook — keeping single-column output
  // byte-identical to before responsive stacking existed.
  const colClass = section.columns > 1 ? ' class="d3-col"' : "";
  const cells = Array.from({ length: section.columns }, (_, i) => {
    const width = widths[i];
    const widthAttr = width ? ` width="${width}"` : "";
    let inner: string;
    let alignAttr = "";
    if (section.kind === "image") {
      inner = serializeImageCell(section.images?.[i], pixelWidth, section.height);
    } else if (section.kind === "button") {
      inner = serializeButtonCell(section.buttons?.[i], section.align ?? "center");
    } else {
      inner = section.content[i] ?? "";
      // Text columns honor the section's horizontal alignment via the cell's `align`
      // attribute — the only email-safe way, since the sanitizer strips style/class.
      // Left is the default, so only center/right need an attribute (keeps the output
      // byte-identical for the many sections that never set an alignment).
      if (section.align === "center" || section.align === "right") {
        alignAttr = ` align="${section.align}"`;
      }
    }
    return `<td${colClass} valign="top"${widthAttr}${alignAttr}>${inner}</td>`;
  }).join("");
  return `<table role="presentation" width="100%"><tbody><tr>${cells}</tr></tbody></table>`;
}

// One call-to-action button: a tight nested table whose single cell carries the
// fill (bgcolor) and the label, the label colored via <font> (our sanitizer has no
// style/class). cellpadding gives the button its padding; align positions it in the
// column. A button missing a label or href serializes to nothing.
function serializeButtonCell(button: SectionButton | null | undefined, align: SectionAlign): string {
  const label = button?.label.trim();
  const href = button?.href.trim();
  if (!button || !label || !href) return "";
  const bg = pickColor(button.bgColor, DEFAULT_BUTTON_BG);
  const text = pickColor(button.textColor, DEFAULT_BUTTON_TEXT);
  // A full-width button stretches its table (and cell) to the column; the alignment
  // attribute is then moot but harmless. A default button hugs its label and is
  // positioned by `align`.
  const full = button.fullWidth ? ` width="100%"` : "";
  // Round the button's filled cell to the campaign's section roundness via the same
  // class-keyed style-block rule the callout uses (border-radius is forbidden inside the
  // sanitized body). The table opts into border-collapse:separate there so the radius
  // actually clips the cell's corners; Outlook ignores it and shows a square fill.
  return (
    `<table role="presentation" border="0" cellpadding="14" align="${align}" class="${BUTTON_ROUND_CLASS}"${full}><tbody><tr>` +
    `<td bgcolor="${bg}" align="center" class="${BUTTON_ROUND_CLASS}"${full}>` +
    `<a href="${escapeHtml(href)}"><font color="${text}"><strong>${escapeHtml(label)}</strong></font></a>` +
    `</td></tr></tbody></table>`
  );
}

// A divider: a horizontal rule (default), or a blank vertical spacer of the section's
// height. The spacer cell carries a non-breaking space so email clients don't
// collapse the empty row.
function serializeDivider(section: CampaignSection): string {
  if (section.line === false) {
    const h = Math.round(
      Math.max(MIN_SPACER_HEIGHT, Math.min(MAX_SPACER_HEIGHT, section.height ?? DEFAULT_SPACER_HEIGHT)),
    );
    return `<table role="presentation" width="100%"><tbody><tr><td height="${h}">&nbsp;</td></tr></tbody></table>`;
  }
  return `<table role="presentation" width="100%"><tbody><tr><td><hr></td></tr></tbody></table>`;
}

// A quote / callout: a single shaded cell holding the rich text (verbatim, already
// allowlist-safe) plus an optional attribution line. cellpadding insets the text
// from the fill edge.
function serializeQuote(section: CampaignSection): string {
  const body = section.content[0] ?? "";
  const bg = pickColor(section.bgColor, DEFAULT_QUOTE_BG);
  const attribution = section.attribution?.trim();
  const attr = attribution ? `<p><em>— ${escapeHtml(attribution)}</em></p>` : "";
  // A rounded callout tags both the table and its cell with the round hook so the
  // email document's <style> can flip border-collapse and apply the corner radius (see
  // wrapEmailDocument). Square (the absence of the flag) emits exactly as before.
  const round = section.rounded === true ? ` class="${QUOTE_ROUND_CLASS}"` : "";
  return (
    `<table role="presentation" width="100%" cellpadding="16"${round}><tbody><tr>` +
    `<td bgcolor="${bg}"${round}>${body}${attr}</td>` +
    `</tr></tbody></table>`
  );
}

// A social row: an optional lead-in followed by the profile links, dot-separated and
// aligned. Rendered as text links (no icon assets needed) so it works in every
// client; each href is escaped and only configured links are emitted.
function serializeSocial(section: CampaignSection): string {
  const items = (section.socials ?? []).filter((s) => s.url.trim());
  if (!items.length) return "";
  const align = section.align ?? "center";
  const intro = section.socialIntro?.trim();
  const introHtml = intro ? `${escapeHtml(intro)} ` : "";
  const links = items
    .map((s) => `<a href="${escapeHtml(s.url.trim())}">${escapeHtml(SOCIAL_LABELS[s.network])}</a>`)
    .join(" · ");
  return (
    `<table role="presentation" width="100%"><tbody><tr>` +
    `<td align="${align}">${introHtml}${links}</td>` +
    `</tr></tbody></table>`
  );
}

// Gutter (px) between a card's image and its text in the side-by-side layouts, so the
// two columns breathe instead of butting together. Mirrors the builder canvas's gap.
const CARD_GUTTER = 24;

// A card: one image paired with rich text. Side-by-side (image-left/right) renders a
// two-cell row with the image hugging a ~40% column; image-top — or when only one of
// the two parts is present — stacks them in a single column.
function serializeCard(section: CampaignSection): string {
  const image = section.images?.[0] ?? null;
  const text = section.content[0] ?? "";
  const hasImage = !!image?.src;
  const hasText = !!text.trim();
  if (!hasImage && !hasText) return "";
  const layout = section.layout ?? "image-left";
  if (layout === "image-top" || !hasImage || !hasText) {
    const imgRow = hasImage
      ? `<tr><td valign="top">${serializeImageCell(image, COLUMN_PIXEL_WIDTHS[1])}</td></tr>`
      : "";
    const textRow = hasText ? `<tr><td valign="top">${text}</td></tr>` : "";
    return `<table role="presentation" width="100%"><tbody>${imgRow}${textRow}</tbody></table>`;
  }
  const imgWidthPx = Math.round(COLUMN_PIXEL_WIDTHS[1] * 0.4);
  // The two cells are vertically centered (valign="middle") so a short image beside
  // long text — the common case — reads as a balanced composition instead of the image
  // floating at the top with a ragged void beneath it. The document stylesheet
  // (render.ts) keeps every other cell top-aligned and honors "middle" only here. A
  // gutter column between them keeps the text off the image, mirroring the builder
  // canvas's gap (the email had none before, so the text butted against the image).
  // The `d3-col` hook stacks the card to image-over-text on phones (see
  // wrapEmailDocument's @media rule), matching the image-top layout. The gutter cell
  // carries it too so it collapses to a zero-height block when stacked rather than
  // leaving a stray table-cell beside two block-level siblings.
  const imgCell = `<td class="d3-col" valign="middle" width="40%">${serializeImageCell(image, imgWidthPx)}</td>`;
  const textCell = `<td class="d3-col" valign="middle" width="60%">${text}</td>`;
  const gutter = `<td class="d3-col" width="${CARD_GUTTER}"></td>`;
  const cells =
    layout === "image-right" ? `${textCell}${gutter}${imgCell}` : `${imgCell}${gutter}${textCell}`;
  return `<table role="presentation" width="100%"><tbody><tr>${cells}</tr></tbody></table>`;
}

// Back-compat / AI-draft path: wrap an existing flat `htmlBody` (or an AI-generated
// draft) as a single full-width text section so legacy drafts open in the section
// builder without a migration. Empty input yields one empty section so the builder
// always has something to render.
export function htmlBodyToSections(html: string | null | undefined): CampaignSection[] {
  const body = html?.trim();
  if (!body) return [emptySection()];
  return [{ id: newSectionId(), columns: 1, kind: "text", content: [body] }];
}

// The layout a brand-new campaign opens with — structure to start from rather than a
// blank canvas: a free text block for the message and a ready-made call-to-action
// button below it. The button starts without an href so it never ships half-built
// (serializeButtonCell skips it until a link is set), but it shows the user where a
// CTA goes. The compliance footer is still appended canonically at send.
export function starterSections(): CampaignSection[] {
  return [
    emptySection(1),
    {
      id: newSectionId(),
      kind: "button",
      columns: 1,
      content: [""],
      // No bgColor/textColor: the button starts as an untouched draft (neutral chip in
      // the editor) and takes its real fill the moment the user picks one or it goes
      // live. Serialize/send still falls back to DEFAULT_BUTTON_BG for a finished button.
      buttons: [{ label: "Get started", href: "" }],
      align: "center",
    },
  ];
}

// Absolute http(s) URL — what an email image src/href must be (relative URLs don't
// resolve in an inbox). Kept as a regex check rather than z.url() so it's explicit
// about the allowed schemes and independent of zod's URL-format details.
const httpUrl = z
  .string()
  .max(2_000)
  .refine((v) => /^https?:\/\/\S+$/i.test(v), { message: "must be an http(s) URL" });

const SectionImageSchema = z
  .object({
    src: httpUrl,
    originalSrc: httpUrl.optional(),
    alt: z.string().max(1_000).optional(),
    href: httpUrl.optional(),
    width: z.number().int().positive().max(MAX_IMAGE_DIMENSION).optional(),
    height: z.number().int().positive().max(MAX_IMAGE_DIMENSION).optional(),
  })
  .strict();

// A presentational color must be one the sanitizer also accepts, so a stored color
// can never be something the delivered email would strip (keeping the round-trip
// invariant). Mirrors render's isSafeColor.
const colorString = z
  .string()
  .max(64)
  .refine((v) => isSafeColor(v), { message: "must be a plain color" });

const SectionButtonSchema = z
  .object({
    label: z.string().max(200),
    href: z.string().max(2_000),
    bgColor: colorString.optional(),
    textColor: colorString.optional(),
    fullWidth: z.boolean().optional(),
  })
  .strict();

const SocialItemSchema = z
  .object({
    network: z.enum([
      "twitter",
      "linkedin",
      "facebook",
      "instagram",
      "youtube",
      "github",
      "website",
      "email",
    ]),
    url: z.string().max(2_000),
  })
  .strict();

export const SectionSchema = z
  .object({
    id: z.string().min(1).max(100),
    columns: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    // Defaulted so stored JSON written before kinds existed parses as text.
    kind: z
      .enum(["text", "image", "button", "divider", "quote", "social", "card"])
      .default("text"),
    content: z.array(z.string().max(MAX_COLUMN_CHARS)).min(1).max(3),
    images: z.array(z.union([SectionImageSchema, z.null()])).min(1).max(3).optional(),
    height: z.number().int().positive().max(MAX_IMAGE_DIMENSION).optional(),
    buttons: z.array(z.union([SectionButtonSchema, z.null()])).min(1).max(3).optional(),
    align: z.enum(["left", "center", "right"]).optional(),
    bgColor: colorString.optional(),
    sectionBg: colorString.optional(),
    attribution: z.string().max(500).optional(),
    rounded: z.boolean().optional(),
    socials: z.array(SocialItemSchema).max(12).optional(),
    socialIntro: z.string().max(200).optional(),
    line: z.boolean().optional(),
    layout: z.enum(["image-left", "image-right", "image-top"]).optional(),
  })
  .superRefine((s, ctx) => {
    if (s.content.length !== s.columns) {
      ctx.addIssue({ code: "custom", message: "content length must equal the column count" });
    }
    if (s.kind === "image" && (!s.images || s.images.length !== s.columns)) {
      ctx.addIssue({ code: "custom", message: "an image section needs one image slot per column" });
    }
    if (s.kind === "button" && (!s.buttons || s.buttons.length !== s.columns)) {
      ctx.addIssue({ code: "custom", message: "a button section needs one button slot per column" });
    }
  });

// The body the sections serialize to must fit the same 500 KB ceiling htmlBody is
// capped at elsewhere — guard it here so an oversized section list is a clean
// validation error rather than a DB write that overflows the column's intent.
export const MAX_SERIALIZED_BODY_CHARS = 500_000;

export const SectionsSchema = z
  .array(SectionSchema)
  .max(MAX_SECTIONS)
  .superRefine((sections, ctx) => {
    if (serializeSections(sections).length > MAX_SERIALIZED_BODY_CHARS) {
      ctx.addIssue({ code: "custom", message: "Email content is too large" });
    }
  });

// Tolerant parse for stored JSON (the DB column may be null, legacy, or hand-edited).
// Returns the validated sections, or null to fall back to the flat-html path.
export function safeParseSections(json: string | null | undefined): CampaignSection[] | null {
  if (!json) return null;
  try {
    const parsed = SectionsSchema.safeParse(JSON.parse(json));
    return parsed.success && parsed.data.length > 0 ? parsed.data : null;
  } catch {
    return null;
  }
}
