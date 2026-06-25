// The campaign's *global theme* — the email-wide styling a user sets from the
// composer's styling panel (page/content background, text/heading/link colors,
// border, and corner roundness). Unlike per-section colors (button fills, callout
// tints) which ride inside the sanitized htmlBody as bgcolor/<font> attributes, the
// theme is structured, validated data applied at *render time* in a server-built
// email-document wrapper (see services/render.ts wrapEmailDocument). That wrapper is
// never run through the body's HTML sanitizer, so the theme can carry things the
// allowlist forbids inside the body — inline `style` for backgrounds, text colors,
// borders, and border-radius — exactly the way the footer and tracking pixel are
// already appended outside the sanitized body. Keeping it out of htmlBody also
// preserves the "what the builder produces is exactly what ships" round-trip
// invariant for the section serializer.
//
// Framework-agnostic (no React) so it can run in the composer, the API routes, the
// worker's render path, and tests alike.
import { z } from "zod";

export type CampaignTheme = {
  // Background behind the email card (the "page"/body color).
  pageBg: string;
  // The email content card's background — what most clients show as the message
  // surface (the "section color").
  contentBg: string;
  // Body text color.
  textColor: string;
  // Heading (h1–h4) color.
  headingColor: string;
  // Link color.
  linkColor: string;
  // The content card's border color.
  borderColor: string;
  // The content card's border width in px (0 = no border).
  borderWidth: number;
  // Corner roundness (px) applied to images in the body.
  imageRadius: number;
  // Corner roundness (px) of the content card / sections.
  sectionRadius: number;
};

// Bounds for the roundness/width controls. Generous but sane — large enough for a
// fully pill-rounded card, small enough that a stray value can't blow out layout.
export const MAX_RADIUS = 40;
export const MAX_BORDER_WIDTH = 8;

// The default look applied when a campaign has no saved theme (new drafts and any
// legacy campaign created before themes existed): a clean, lightly-bordered white
// card on a soft grey page — what a polished newsletter tends to look like.
export const DEFAULT_THEME: CampaignTheme = {
  pageBg: "#f4f4f5",
  contentBg: "#ffffff",
  textColor: "#1a1a1a",
  headingColor: "#111827",
  linkColor: "#2563eb",
  borderColor: "#e5e7eb",
  borderWidth: 1,
  imageRadius: 0,
  sectionRadius: 12,
};

// True for a plain color token safe to drop into a server-built `style="…"`
// attribute: a hex triplet/quad, an rgb()/rgba() with numeric components, or a small
// set of CSS named colors. Mirrors render.ts isSafeColor (kept independent to avoid a
// module cycle), and — crucially — admits no quote/semicolon/brace/url()/expression,
// so a theme value can never break out of the attribute or smuggle CSS.
const NAMED_COLORS = new Set([
  "transparent", "black", "white", "red", "green", "blue", "yellow", "orange",
  "purple", "pink", "gray", "grey", "silver", "gold", "cyan", "magenta", "navy",
  "teal", "maroon", "olive", "lime", "aqua", "fuchsia",
]);
export function isThemeColor(value: string): boolean {
  const v = value.trim().toLowerCase();
  if (/^#[0-9a-f]{3,8}$/.test(v)) return true;
  if (/^rgba?\(\s*[0-9.,%\s]+\)$/.test(v)) return true;
  return NAMED_COLORS.has(v);
}

const themeColor = z
  .string()
  .max(64)
  .refine((v) => isThemeColor(v), { message: "must be a plain color" });

const radius = z.number().int().min(0).max(MAX_RADIUS);

// Every field optional so a partial theme (e.g. only a changed text color) round-
// trips; resolveTheme() fills the rest from DEFAULT_THEME. `.strict()` rejects stray
// keys so a malformed/hand-edited blob fails cleanly rather than storing junk.
export const CampaignThemeSchema = z
  .object({
    pageBg: themeColor.optional(),
    contentBg: themeColor.optional(),
    textColor: themeColor.optional(),
    headingColor: themeColor.optional(),
    linkColor: themeColor.optional(),
    borderColor: themeColor.optional(),
    borderWidth: z.number().int().min(0).max(MAX_BORDER_WIDTH).optional(),
    imageRadius: radius.optional(),
    sectionRadius: radius.optional(),
  })
  .strict();

export type CampaignThemeInput = z.infer<typeof CampaignThemeSchema>;

// Fills any unset field from DEFAULT_THEME, so render/preview/canvas always work with
// a complete theme. Accepts null/undefined (legacy campaigns) → the defaults.
export function resolveTheme(partial: CampaignThemeInput | null | undefined): CampaignTheme {
  return { ...DEFAULT_THEME, ...(partial ?? {}) };
}

// Tolerant parse for the stored JSON column (may be null, legacy, or hand-edited).
// Returns the validated partial theme, or null to fall back to the defaults.
export function safeParseTheme(json: string | null | undefined): CampaignThemeInput | null {
  if (!json) return null;
  try {
    const parsed = CampaignThemeSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// CSS custom properties for the *live editing canvas*, so the composer's section
// editors reflect the theme as it's tuned (true WYSIWYG). Consumed by the themed
// canvas wrapper in the composer and the `.d3-prose` rules in globals.css, which read
// these vars with a fallback to the app's neutral editor look when unset.
//
// It also RE-SCOPES the app's foreground/muted/border tokens to colors derived from
// the theme. The composer chrome inside the card (header labels, inputs, placeholders,
// footer fine print) reads `var(--foreground)` / `var(--muted-foreground)` etc., which
// in dark mode are light — so on a forced-light content background they'd wash out.
// Pinning them to the theme's text color (and color-mixed muted/border variants toward
// the content background) keeps every bit of text legible on the card regardless of the
// app's light/dark mode. Overlays that portal out of the card (Select/Popover content)
// keep the app tokens, which is what we want.
export function themeCanvasVars(theme: CampaignTheme): Record<`--${string}`, string> {
  const text = theme.textColor;
  const bg = theme.contentBg;
  // A readable "muted" = text mixed partway toward the background; a hairline border
  // the same way but much closer to the background.
  const muted = `color-mix(in srgb, ${text} 60%, ${bg})`;
  const border = `color-mix(in srgb, ${text} 16%, ${bg})`;
  // Subtle surface tints for hover/active affordances — text barely mixed into the
  // background, so they read as a faint highlight on the (typically light) card.
  const mutedSurface = `color-mix(in srgb, ${text} 6%, ${bg})`;
  const accentSurface = `color-mix(in srgb, ${text} 10%, ${bg})`;
  return {
    "--d3-page-bg": theme.pageBg,
    "--d3-content-bg": theme.contentBg,
    "--d3-text": theme.textColor,
    "--d3-heading": theme.headingColor,
    "--d3-link": theme.linkColor,
    "--d3-border-color": theme.borderColor,
    "--d3-border-width": `${theme.borderWidth}px`,
    "--d3-img-radius": `${theme.imageRadius}px`,
    "--d3-section-radius": `${theme.sectionRadius}px`,
    // Re-scoped app tokens so nested chrome stays legible on the content background.
    // The *foreground* tokens pin text to the theme's text color; the *surface* tokens
    // (background/card/popover and the muted/accent hover fills + their active chips)
    // are derived from the content background so a button's hover/active state keeps
    // contrast with that text. Without re-scoping the surfaces too, dark-mode hover
    // fills (--muted/--accent) stayed dark while the text was pinned dark → dark-on-dark
    // on hover. Overlays that portal out of the card (Select/Popover/Menu content) sit
    // outside this subtree and keep the app tokens, which is what we want.
    "--foreground": text,
    "--card-foreground": text,
    "--popover-foreground": text,
    "--accent-foreground": text,
    "--muted-foreground": muted,
    "--background": bg,
    "--card": bg,
    "--popover": bg,
    "--muted": mutedSurface,
    "--accent": accentSurface,
    "--border": border,
    "--input": border,
  };
}
