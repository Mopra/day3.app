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

// The HTML contract handed to the model on every body-producing call. Kept as a
// subset of the render.ts allowlist so sanitize is a no-op on well-behaved output.
const HTML_RULES = `Write the body as simple, email-safe HTML using ONLY these tags:
<h1> <h2> <h3> <p> <ul> <ol> <li> <a href="..."> <strong> <em> <u> <blockquote> <hr> <br>.
Rules:
- NEVER use style attributes, class attributes, <div>, <span>, <table>, <img>, <script>, or any inline CSS. They will be stripped.
- Use <strong> for emphasis, not <b>. Keep paragraphs short.
- Use real links: <a href="https://...">clear call to action</a>. Include at most one primary call to action.
- You MAY personalize with these merge tags exactly as written: {{first_name}}, {{last_name}}, {{email}}. Prefer {{first_name}} in the greeting. Never invent other merge tags.
- Do NOT add an unsubscribe link or footer — one is appended automatically.
- Do NOT include <html>, <head>, or <body> wrappers. Output only the body fragment.`;

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
  html: string;
  usage: Usage;
};

/** Draft a full email (subject + inbox preview + body) from a one-line brief. */
export async function draftEmail(input: DraftInput): Promise<DraftResult> {
  const { object, usage } = await generateObject({
    model: model(),
    schema: z.object({
      subject: z.string().describe("Compelling subject line, under ~60 characters, no clickbait."),
      previewText: z
        .string()
        .describe("Inbox preview snippet that complements (does not repeat) the subject, 40-90 characters."),
      html: z.string().describe("The email body as an HTML fragment following the formatting rules."),
    }),
    temperature: 0.7,
    system: SYSTEM,
    prompt: `Write a product newsletter email for ${input.companyName}${
      input.audienceName ? ` (audience: ${input.audienceName})` : ""
    }${input.fromName ? `, from ${input.fromName}` : ""}.

What it's about:
${input.brief}${toneLine(input.tone)}

${HTML_RULES}`,
  });
  return {
    subject: object.subject.trim(),
    previewText: object.previewText.trim(),
    html: sanitizeHtml(object.html),
    usage,
  };
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

const REWRITE_INSTRUCTIONS: Record<string, string> = {
  improve: "Improve the writing: clearer, tighter, more engaging, while keeping the meaning and roughly the same length.",
  shorten: "Make it noticeably shorter and punchier while keeping the key point.",
  friendly: "Make the tone warmer and friendlier, conversational but still professional.",
  professional: "Make the tone more polished and professional, without being stiff.",
  grammar: "Fix only spelling, grammar, and punctuation. Do not change the wording, tone, or meaning otherwise.",
};

export type RewriteAction = keyof typeof REWRITE_INSTRUCTIONS;
export const REWRITE_ACTIONS = Object.keys(REWRITE_INSTRUCTIONS) as RewriteAction[];

/** Rewrite a selected snippet of plain text per the chosen action. */
export async function rewriteText(
  input: { text: string; action: string },
): Promise<{ text: string; usage: Usage }> {
  const instruction = REWRITE_INSTRUCTIONS[input.action] ?? REWRITE_INSTRUCTIONS.improve;
  const { text, usage } = await generateText({
    model: model(),
    temperature: input.action === "grammar" ? 0.2 : 0.5,
    system: `${SYSTEM}

You are editing a fragment of an email. ${instruction}
Preserve any merge tags such as {{first_name}} exactly. Return ONLY the rewritten text with no quotes, no preamble, no explanation, and no markdown.`,
    prompt: input.text,
  });
  return { text: text.trim(), usage };
}
