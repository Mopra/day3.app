// A signup form's *design* — the look the form builder lets a user tune from the
// Design panel: page/card backgrounds, heading/body text colors, card roundness, and
// an optional top banner image. Stored as a JSON string in forms.design (mirrors the
// campaign theme_json approach in lib/theme.ts) and applied at render time as inline
// styles in components/public-form-view.tsx — which is what every public surface
// (hosted page, iframe embed, JS-widget popup) renders, so a design change shows up
// across all of them at once. The raw-HTML install snippet is the only surface it
// doesn't reach (that one is explicitly "restyle it yourself").
//
// The accent (button / required-marker) color is intentionally NOT part of this — it
// keeps living in the legacy forms.accentColor column so existing forms keep their
// button color untouched. The design panel edits both, but they persist separately.
//
// Framework-agnostic (no React) so it runs in the editor, the API routes, the public
// render path, and tests alike. Every color passes isThemeColor — the same gate the
// campaign theme uses — so a value can never break out of an inline `style="…"`.
import { z } from "zod";
import { isThemeColor } from "@/lib/theme";

export type FormDesign = {
  // Background behind the form card (the hosted page). Embeds stay transparent so
  // they blend into the host site regardless of this.
  pageBg: string;
  // The form card's surface color.
  cardBg: string;
  // Headline color.
  headingColor: string;
  // Description + footer note color.
  textColor: string;
  // Card corner roundness in px.
  cornerRadius: number;
  // Optional banner image shown flush across the top of the card.
  imageUrl: string | null;
  // Alt text for the banner image.
  imageAlt: string;
};

// Upper bound for the roundness control — enough for a soft, pill-ish card without
// letting a stray value blow out the layout.
export const MAX_FORM_RADIUS = 28;

// The look applied when a form has no saved design (every form created before designs
// existed, and new forms). These values reproduce the previous hardcoded render
// exactly — a clean white card on a soft grey page — so adding the feature changes
// nothing visually until a user opts to tune it.
export const DEFAULT_FORM_DESIGN: FormDesign = {
  pageBg: "#f6f7f9",
  cardBg: "#ffffff",
  headingColor: "#111827",
  textColor: "#4b5563",
  cornerRadius: 14,
  imageUrl: null,
  imageAlt: "",
};

const formColor = z
  .string()
  .max(64)
  .refine((v) => isThemeColor(v), { message: "must be a plain color" });

// The banner image must be an absolute https URL (it's dropped into <img src>). We
// don't pin the host — uploads land in our public asset bucket, but a user pasting a
// hosted logo URL is fine too; an https image URL can't break out of the attribute.
const imageUrlSchema = z.string().trim().url().max(2048).refine((v) => /^https:\/\//i.test(v), {
  message: "must be an https URL",
});

// Every field optional so a partial design round-trips; resolveFormDesign() fills the
// rest from the defaults. `.strict()` rejects stray keys so a hand-edited blob fails
// cleanly rather than storing junk.
export const FormDesignSchema = z
  .object({
    pageBg: formColor.optional(),
    cardBg: formColor.optional(),
    headingColor: formColor.optional(),
    textColor: formColor.optional(),
    cornerRadius: z.number().int().min(0).max(MAX_FORM_RADIUS).optional(),
    imageUrl: z.union([imageUrlSchema, z.literal(""), z.null()]).optional(),
    imageAlt: z.string().trim().max(200).optional(),
  })
  .strict();

export type FormDesignInput = z.infer<typeof FormDesignSchema>;

// Fills any unset field from the defaults so render/preview always work with a complete
// design. Accepts either the stored JSON string (server render path) or an already-
// parsed partial (the editor holds the resolved object) or null/undefined (legacy).
export function resolveFormDesign(
  input: string | FormDesignInput | null | undefined,
): FormDesign {
  const partial = typeof input === "string" ? safeParseFormDesign(input) : input ?? null;
  const merged: FormDesign = { ...DEFAULT_FORM_DESIGN, ...(partial ?? {}) };
  if (!merged.imageUrl) merged.imageUrl = null;
  return merged;
}

// Tolerant parse for the stored JSON column (may be null, legacy, or hand-edited).
// Returns the validated partial, or null to fall back to the defaults.
export function safeParseFormDesign(json: string | null | undefined): FormDesignInput | null {
  if (!json) return null;
  try {
    const parsed = FormDesignSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// API write path: a validated design object → the JSON string stored in the column
// (or null when absent/invalid, so the form falls back to the defaults).
export function formDesignJson(input: FormDesignInput | null | undefined): string | null {
  if (!input) return null;
  const parsed = FormDesignSchema.safeParse(input);
  if (!parsed.success) return null;
  return JSON.stringify(parsed.data);
}
