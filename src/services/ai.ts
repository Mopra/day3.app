// AI assist for campaign authoring (OpenRouter via the Vercel AI SDK).
//
// Design rules that keep this safe and "bulletproof":
//   1. Every HTML string the model returns is passed through sanitizeHtml()
//      before it leaves this module. The model is INSTRUCTED to use only the
//      newsletter-safe tag subset, but we never trust it — sanitize is the
//      enforcement. This guarantees AI output renders identically to what
//      subscribers receive (same invariant the editor relies on).
//   2. The model subset (h1-h3, p, ul/ol/li, a, strong, em, u, blockquote, hr,
//      br) is a strict subset of the sanitizer allowlist in services/render.ts,
//      so sanitize never strips the model's intended formatting.
//   3. Merge tags ({{first_name}}, {{last_name}}, {{email}}) are passed through
//      verbatim — they survive sanitize and are substituted per-recipient on send.
//   4. AI is OPTIONAL. aiEnabled() gates the feature; callers return 503 when the
//      key is absent so the app runs unchanged without OpenRouter configured.
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { generateObject, generateText } from "ai";
import { z } from "zod";
import { sanitizeHtml } from "@/services/render";
import type { TokenUsage } from "@/lib/ai-budget";
import {
  DEFAULT_BUTTON_BG,
  DEFAULT_BUTTON_TEXT,
  DEFAULT_QUOTE_BG,
  DEFAULT_SPACER_HEIGHT,
  SectionsSchema,
  newSectionId,
  serializeSections,
  type CampaignSection,
  type ColumnCount,
} from "@/lib/sections";

// Token counts a call consumed, returned alongside every result so the route can
// charge it against the account's AI budget (see lib/ai-budget.ts).
export type Usage = TokenUsage;

const DEFAULT_MODEL = "anthropic/claude-sonnet-4.6";

/** True when OpenRouter is configured. Callers hide the AI UI / return 503 otherwise. */
export function aiEnabled(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY);
}

function model() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    // Guarded by aiEnabled() at the route layer; this is a defensive backstop.
    throw new Error("OPENROUTER_API_KEY is not set");
  }
  const openrouter = createOpenRouter({ apiKey });
  return openrouter(process.env.OPENROUTER_MODEL || DEFAULT_MODEL);
}

// The inline-HTML contract handed to the model for every rich-text field (a text
// block, a column, or a quote). Kept as a subset of the render.ts allowlist so
// sanitize is a no-op on well-behaved output. Block-level structure (headings as
// their own blocks, CTAs, dividers, callouts) is expressed by the block list below,
// NOT by raw HTML — so these rules cover only what goes *inside* one rich-text field.
const HTML_RULES = `Each rich-text field (a text block's "html", a column, or a quote) is a small HTML fragment using ONLY these tags:
<h1> <h2> <h3> <p> <ul> <ol> <li> <a href="..."> <strong> <em> <u> <br>.
Rules for these fragments:
- NEVER use style attributes, class attributes, <div>, <span>, <table>, <img>, <hr>, <script>, or any inline CSS. They will be stripped.
- Use <strong> for emphasis, not <b>. Keep paragraphs short and scannable.
- Links are real: <a href="https://...">descriptive text</a>. Reserve the standalone CTA for a "button" block (don't also bury the main action in a paragraph link).
- You MAY personalize with these merge tags exactly as written: {{first_name}}, {{last_name}}, {{email}}. Prefer {{first_name}} in the greeting. Never invent other merge tags.
- Do NOT add an unsubscribe link or footer — one is appended automatically.
- Do NOT output <hr>, <html>, <head>, or <body> — use a "divider" block for separators.`;

// The block vocabulary the model assembles an email from. This mirrors the section
// builder's kinds that the model can author with no external assets (it can't upload
// images, so image/card sections and a social row of real profile URLs are left for
// the user to add). Each block maps 1:1 to a CampaignSection in aiBlocksToSections.
const BLOCK_RULES = `Compose the email as an ORDERED LIST of blocks, like a real newsletter — a heading, an intro, the body broken up with subheadings, an optional callout, a clear button, separators where they help. Use a mix; do not return one giant text block.
Block types (set "type" to one and fill ONLY that type's fields):
- "text": a rich-text block in "html". The main building block — a heading, a paragraph, a bulleted list, etc.
- "columns": 2 or 3 short side-by-side rich-text fragments in "columns" (e.g. a feature grid or a set of stats). Each fragment is its own small HTML fragment; keep them short and parallel.
- "button": a standalone call-to-action button — "label" (the button text) and "href" (an https:// URL). Use ONE primary button for the email's main action; a second is fine only if there's a genuinely distinct secondary action.
- "quote": a shaded callout box for a testimonial or a key takeaway — the quote text in "html", plus optional "attribution" (e.g. "Jane Doe, Acme").
- "divider": a separator between parts of the email. Set "spacer" to false (or omit) for a thin horizontal rule; set it to true for blank vertical breathing room.
Guidance: open with a heading and a warm intro, keep one clear primary button, and use dividers/spacers and the occasional quote or columns block to give the email rhythm. 5–12 blocks is typical. If you don't have a real https:// URL for a button, omit the button rather than inventing one.`;

const SYSTEM = `You are an expert email copywriter for small SaaS teams sending product newsletters.
You write warm, concise, scannable emails that sound human — never spammy, never hype, no ALL CAPS, no excessive exclamation marks, no "act now" pressure. Favor clarity and a single clear next step.`;

function toneLine(tone?: string): string {
  return tone ? `\nDesired tone: ${tone}.` : "";
}

export type DraftInput = {
  brief: string;
  tone?: string;
  companyName: string;
  audienceName?: string;
  fromName?: string;
};

export type DraftResult = {
  subject: string;
  previewText: string;
  // The structured body the composer drops straight into its section builder — a
  // full, multi-section email rather than one text block. Already validated against
  // SectionsSchema, so it round-trips through the builder and send pipeline unchanged.
  sections: CampaignSection[];
  // The same body serialized to email-safe htmlBody, for previews / any flat consumer.
  html: string;
  usage: Usage;
};

// One block as the model returns it. A deliberately small, AI-friendly shape: a
// `type` plus only the fields that type uses (others left undefined). Converted to a
// real CampaignSection by aiBlocksToSections. NOTE: no array min/max here — Anthropic's
// structured-output schema rejects array minItems/maxItems other than 0/1, so the
// 2-or-3 column count is steered by the prompt and clamped in conversion.
const AiBlockSchema = z.object({
  type: z
    .enum(["text", "columns", "button", "divider", "quote"])
    .describe("The block kind. Fill only the fields this kind uses."),
  html: z
    .string()
    .optional()
    .describe("For 'text' and 'quote': the content as an HTML fragment using the allowed inline tags."),
  columns: z
    .array(z.string())
    .optional()
    .describe("For 'columns': 2 or 3 short side-by-side HTML fragments."),
  label: z.string().optional().describe("For 'button': the button label text."),
  href: z.string().optional().describe("For 'button': the https:// URL the button links to."),
  attribution: z
    .string()
    .optional()
    .describe("For 'quote': optional attribution, e.g. 'Jane Doe, Acme'."),
  spacer: z
    .boolean()
    .optional()
    .describe("For 'divider': true for blank vertical space, false/omitted for a horizontal rule."),
});
export type AiBlock = z.infer<typeof AiBlockSchema>;

// A plain full-width rich-text section.
function textSection(html: string): CampaignSection {
  return { id: newSectionId(), kind: "text", columns: 1, content: [html] };
}

// Converts the model's block list into builder sections, sanitizing every rich-text
// field (the same enforcement draftEmail's flat output used to get) and skipping
// blocks that came back empty or malformed (a button with no link, an empty quote) so
// the draft never lands a half-built section. Falls back to a single text section if
// nothing survives, so the composer always opens with a usable draft.
export function aiBlocksToSections(blocks: AiBlock[]): CampaignSection[] {
  const out: CampaignSection[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "button": {
        const label = b.label?.trim();
        const href = b.href?.trim();
        // Only ship a button with a real label and an http(s) link — otherwise the AI
        // invented or omitted the URL; drop it rather than emit a dead CTA.
        if (!label || !href || !/^https?:\/\/\S+$/i.test(href)) break;
        out.push({
          id: newSectionId(),
          kind: "button",
          columns: 1,
          content: [""],
          buttons: [{ label, href, bgColor: DEFAULT_BUTTON_BG, textColor: DEFAULT_BUTTON_TEXT }],
          align: "center",
        });
        break;
      }
      case "divider": {
        out.push(
          b.spacer
            ? { id: newSectionId(), kind: "divider", columns: 1, content: [""], line: false, height: DEFAULT_SPACER_HEIGHT }
            : { id: newSectionId(), kind: "divider", columns: 1, content: [""], line: true },
        );
        break;
      }
      case "quote": {
        const html = sanitizeHtml(b.html ?? "").trim();
        if (!html) break;
        out.push({
          id: newSectionId(),
          kind: "quote",
          columns: 1,
          content: [html],
          bgColor: DEFAULT_QUOTE_BG,
          attribution: b.attribution?.trim() || undefined,
        });
        break;
      }
      case "columns": {
        const cols = (b.columns ?? []).map((c) => sanitizeHtml(c ?? "").trim()).filter(Boolean);
        // Need at least two non-empty fragments for a real multi-column row; with one
        // (or none) fall back to a plain text block so the content isn't dropped.
        if (cols.length < 2) {
          if (cols.length === 1) out.push(textSection(cols[0]));
          break;
        }
        const n = Math.min(3, cols.length) as ColumnCount;
        out.push({ id: newSectionId(), kind: "text", columns: n, content: cols.slice(0, n) });
        break;
      }
      case "text":
      default: {
        const html = sanitizeHtml(b.html ?? "").trim();
        if (html) out.push(textSection(html));
        break;
      }
    }
  }
  return out;
}

/** Draft a full, multi-section email (subject + inbox preview + body) from a one-line brief. */
export async function draftEmail(input: DraftInput): Promise<DraftResult> {
  const { object, usage } = await generateObject({
    model: model(),
    schema: z.object({
      subject: z.string().describe("Compelling subject line, under ~60 characters, no clickbait."),
      previewText: z
        .string()
        .describe("Inbox preview snippet that complements (does not repeat) the subject, 40-90 characters."),
      blocks: z
        .array(AiBlockSchema)
        .describe("The email body as an ordered list of blocks following the block rules."),
    }),
    temperature: 0.7,
    system: SYSTEM,
    prompt: `Write a product newsletter email for ${input.companyName}${
      input.audienceName ? ` (audience: ${input.audienceName})` : ""
    }${input.fromName ? `, from ${input.fromName}` : ""}.

What it's about:
${input.brief}${toneLine(input.tone)}

${BLOCK_RULES}

${HTML_RULES}`,
  });

  // Convert and validate. SectionsSchema enforces the per-section invariants and the
  // serialized-size ceiling; if the model produced something that doesn't validate (or
  // nothing usable), fall back to a single text section built from any text/quote HTML
  // so the user still gets a draft rather than an error.
  const built = aiBlocksToSections(object.blocks ?? []);
  const parsed = SectionsSchema.safeParse(built);
  const sections =
    parsed.success && parsed.data.length > 0 ? parsed.data : fallbackSections(object.blocks ?? []);

  return {
    subject: object.subject.trim(),
    previewText: object.previewText.trim(),
    sections,
    html: serializeSections(sections),
    usage,
  };
}

// Last-resort body when the structured blocks don't validate: stitch every rich-text
// fragment into one text section. Guarantees a non-empty, schema-valid draft.
function fallbackSections(blocks: AiBlock[]): CampaignSection[] {
  const html = blocks
    .flatMap((b) => [b.html, ...(b.columns ?? [])])
    .map((h) => sanitizeHtml(h ?? "").trim())
    .filter(Boolean)
    .join("\n");
  return [textSection(html || "<p></p>")];
}

export type SubjectInput = {
  companyName: string;
  brief?: string;
  subject?: string;
  html?: string;
};

/** Suggest 5 subject-line options from a brief and/or the current draft. */
export async function suggestSubjects(
  input: SubjectInput,
): Promise<{ subjects: string[]; usage: Usage }> {
  const context = [
    input.brief ? `Brief: ${input.brief}` : "",
    input.subject ? `Current subject: ${input.subject}` : "",
    input.html ? `Email body:\n${input.html}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const { object, usage } = await generateObject({
    model: model(),
    // NOTE: no array min/max here — Anthropic's structured-output schema rejects
    // array minItems/maxItems other than 0/1. Count is steered by the prompt and
    // enforced by the slice below.
    schema: z.object({
      subjects: z
        .array(z.string())
        .describe("Exactly 5 distinct subject lines, each under ~60 characters."),
    }),
    temperature: 0.9,
    system: SYSTEM,
    prompt: `Write 5 distinct, high-open-rate subject lines for this ${input.companyName} newsletter. Vary the angle (benefit, curiosity, direct, playful). No clickbait, no ALL CAPS, at most one emoji and only if it fits naturally.

${context || "A product update newsletter."}`,
  });
  const subjects = object.subjects
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 5);
  return { subjects, usage };
}

/** Write the inbox preview snippet from the subject + body. */
export async function writePreviewText(
  input: { subject: string; html: string },
): Promise<{ previewText: string; usage: Usage }> {
  const { object, usage } = await generateObject({
    model: model(),
    schema: z.object({
      previewText: z
        .string()
        .describe("Inbox preview snippet, 40-90 characters, complements the subject without repeating it."),
    }),
    temperature: 0.5,
    system: SYSTEM,
    prompt: `Write the inbox preview text (the grey snippet shown after the subject) for this email. It should entice the open and complement the subject without repeating it. 40-90 characters, no trailing ellipsis.

Subject: ${input.subject}

Body:
${input.html}`,
  });
  return { previewText: object.previewText.trim(), usage };
}

/** Rewrite a selected snippet of plain text per the user's free-form instruction. */
export async function rewriteText(
  input: { text: string; instruction: string },
): Promise<{ text: string; usage: Usage }> {
  const { text, usage } = await generateText({
    model: model(),
    temperature: 0.5,
    system: `${SYSTEM}

You are editing a fragment of an email. Apply the user's instruction to the selected text.
Stay faithful to the user's intent; if the instruction is unclear, make a sensible improvement rather than guessing wildly.
Preserve any merge tags such as {{first_name}} exactly. Return ONLY the edited text with no quotes, no preamble, no explanation, and no markdown.`,
    prompt: `Instruction: ${input.instruction}\n\nText to edit:\n${input.text}`,
  });
  return { text: text.trim(), usage };
}
