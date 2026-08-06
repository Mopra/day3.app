// Ready-made campaign starting points. A template is *pure data* — a section list
// plus a global theme — so it needs no database table, no migration, and no server
// round trip: applying one is exactly the same client-side operation as an edit the
// user made by hand.
//
// Why templates exist alongside the AI composer: they solve different halves of the
// problem. A template supplies *structure* (hero → cards → call to action → social
// row) and a coherent *look*; the AI assistant supplies *words*. They compose — pick
// a layout, then let AI (or yourself) fill the copy. Templates are also the only
// "this already looks good" moment available on the free tier, which has no AI
// allowance (see plans-catalog's planHasAI). They are deliberately
// unmetered: nothing here sends mail, so nothing here is gated (see AGENTS.md §5).
//
// Two invariants keep this module honest, both covered by tests:
//   1. Every template's sections parse under SectionsSchema — a template can never
//      be something the API would reject on save.
//   2. Every template's serialized body is a fixed point of sanitizeHtml(), so the
//      "what the builder produces is exactly what ships" guarantee holds for
//      template content just as it does for hand-authored content.
//
// Placeholder conventions, mirroring how starterSections() ships a button with no
// href: an image section carries *empty slots* (never a stock URL), so the builder
// shows an upload target and the unfilled section serializes to nothing rather than
// shipping someone else's picture. Buttons carry a label but no href for the same
// reason. Merge tags always carry a fallback ({{first_name|there}}) so a template
// reads correctly for an audience that never collected that field.
//
// Framework-agnostic (no React) so the composer, tests, and any future server-side
// consumer can all read it.
import {
  newSectionId,
  type CampaignSection,
  type ColumnCount,
  type SectionKind,
} from "@/lib/sections";
import type { CampaignThemeInput } from "@/lib/theme";

export type CampaignTemplate = {
  /** Stable identifier — used as the React key and in analytics/telemetry. */
  key: string;
  /** Gallery name. */
  name: string;
  /** One line on what this template is for, shown under the name. */
  description: string;
  /**
   * The template's shape in words ("Hero · 2 feature cards · CTA"), shown beneath
   * the thumbnail. A thumbnail renders the template *as it stands* — with empty
   * image slots contributing nothing — so this line is what tells the user the
   * layout also has a hero image waiting for their upload.
   */
  structure: string;
  /** Suggested subject line. Applied only when the campaign's subject is empty. */
  subject: string;
  /** Suggested preview text. Applied only when the campaign's is empty. */
  previewText: string;
  /** The look. A full theme per template — the styling is half of what makes a template. */
  theme: CampaignThemeInput;
  /**
   * Built fresh on every call so each application mints new section ids (they are
   * the React keys and drag-and-drop sortable ids, so two applications must never
   * share them).
   */
  build: () => CampaignSection[];
};

// --- Section builders ------------------------------------------------------
// Small helpers so each template below reads as a layout rather than a wall of
// object literals. Each returns a section with `content` correctly sized to its
// column count — the invariant SectionSchema enforces.

function text(
  html: string,
  opts: { align?: "left" | "center" | "right"; bg?: string } = {},
): CampaignSection {
  return {
    id: newSectionId(),
    kind: "text",
    columns: 1,
    content: [html],
    ...(opts.align ? { align: opts.align } : {}),
    ...(opts.bg ? { sectionBg: opts.bg } : {}),
  };
}

// A multi-column text row — one HTML string per column.
function columns(content: string[]): CampaignSection {
  return {
    id: newSectionId(),
    kind: "text",
    columns: content.length as ColumnCount,
    content,
  };
}

// An empty image slot per column: the builder shows an upload target, and until the
// user fills it the section serializes to nothing (so an unfinished template never
// ships a broken or borrowed image).
function imagePlaceholder(cols: ColumnCount = 1, height?: number): CampaignSection {
  return {
    id: newSectionId(),
    kind: "image",
    columns: cols,
    content: Array.from({ length: cols }, () => ""),
    images: Array.from({ length: cols }, () => null),
    ...(height ? { height } : {}),
  };
}

// A call to action. `href` is intentionally empty — the label shows the user where
// the CTA goes, and serializeButtonCell skips a button until it has a real link.
function button(
  label: string,
  bgColor: string,
  opts: { fullWidth?: boolean } = {},
): CampaignSection {
  return {
    id: newSectionId(),
    kind: "button",
    columns: 1,
    content: [""],
    align: "center",
    buttons: [{ label, href: "", bgColor, textColor: "#ffffff", ...opts }],
  };
}

function rule(): CampaignSection {
  return { id: newSectionId(), kind: "divider", columns: 1, content: [""], line: true };
}

// Note: no spacer helper. The serializer already puts a 16px gap between sections, and
// an explicit spacer next to a placeholder that hasn't been filled in yet (a button with
// no link) stacks with those gaps into a visible hole — so templates ride the default
// rhythm and let the user add a spacer where they want one.
function quote(html: string, bgColor: string, attribution?: string): CampaignSection {
  return {
    id: newSectionId(),
    kind: "quote",
    columns: 1,
    content: [html],
    bgColor,
    rounded: true,
    ...(attribution ? { attribution } : {}),
  };
}

// A card: one image beside rich text. The image slot starts empty (see
// imagePlaceholder) so the card renders as text until the user uploads.
function card(html: string, layout: "image-left" | "image-right" | "image-top"): CampaignSection {
  return {
    id: newSectionId(),
    kind: "card",
    columns: 1,
    content: [html],
    images: [null],
    layout,
  };
}

// A social row with no links configured yet: it shows the user the section exists
// (and its editor lets them add profiles) while serializing to nothing until they do.
function social(intro: string): CampaignSection {
  return {
    id: newSectionId(),
    kind: "social",
    columns: 1,
    content: [""],
    align: "center",
    socialIntro: intro,
    socials: [],
  };
}

// --- The templates ---------------------------------------------------------
// Deliberately few. Every section kind added to the builder means auditing each
// template, so five well-made starting points beat twenty stale ones. Each one is a
// shape small SaaS teams actually send.

export const CAMPAIGN_TEMPLATES: CampaignTemplate[] = [
  {
    key: "product-update",
    name: "Product update",
    description: "What shipped since last time, one feature per card.",
    structure: "Intro · 2 feature cards (image optional) · CTA · social row",
    subject: "What's new this month",
    previewText: "Three improvements we think you'll like.",
    theme: {
      pageBg: "#f4f4f5",
      contentBg: "#ffffff",
      textColor: "#27272a",
      headingColor: "#111827",
      linkColor: "#2563eb",
      borderColor: "#e5e7eb",
      borderWidth: 1,
      imageRadius: 8,
      sectionRadius: 12,
    },
    build: () => [
      text(
        "<h1>What's new</h1>" +
          "<p>Hi {{first_name|there}},</p>" +
          "<p>A short line on the theme of this update — what you've been working on and why it matters to them.</p>",
      ),
      rule(),
      card(
        "<h3>First feature</h3><p>What it does, in one sentence. Then a second sentence on the problem it removes.</p>",
        "image-left",
      ),
      card(
        "<h3>Second feature</h3><p>Keep each card to two or three lines — the detail belongs on the linked page.</p>",
        "image-right",
      ),
      button("See what's new", "#2563eb"),
      rule(),
      text(
        "<p>Anything you'd like us to build next? Just reply to this email — it comes straight to us.</p>",
      ),
      social("Follow along:"),
    ],
  },
  {
    key: "launch",
    name: "Launch announcement",
    description: "One thing, said loudly, with a single call to action.",
    structure: "Colored hero · image · one-line pitch · full-width CTA · quote",
    subject: "Introducing something new",
    previewText: "It's live today, and it's included in your plan.",
    theme: {
      pageBg: "#111827",
      contentBg: "#ffffff",
      textColor: "#1f2937",
      headingColor: "#111827",
      linkColor: "#4f46e5",
      borderColor: "#111827",
      borderWidth: 0,
      imageRadius: 12,
      sectionRadius: 20,
    },
    build: () => [
      // The hero is a colored band rather than an image, so the template looks
      // finished before the user uploads anything — the optional image sits below it.
      text(
        "<h1>Introducing <em>your thing</em></h1>" +
          "<p>The one-sentence version of what it is and who it's for.</p>",
        { align: "center", bg: "#eef2ff" },
      ),
      imagePlaceholder(1, 260),
      text(
        "<p>Hi {{first_name|there}},</p>" +
          "<p>Two or three sentences on why you built this and what changes for them today. Resist listing every detail — the goal of this email is one click.</p>",
      ),
      button("Try it now", "#4f46e5", { fullWidth: true }),
      quote(
        "<p>A short line from an early user or beta customer — proof beats adjectives.</p>",
        "#f5f3ff",
        "Add their name, Company",
      ),
      social("More from us:"),
    ],
  },
  {
    key: "founder-note",
    name: "Founder note",
    description: "A plain personal letter. No chrome, no layout — highest reply rate.",
    structure: "Just text, styled like a real email from a person",
    subject: "A quick note from me",
    previewText: "No announcement — just something I've been thinking about.",
    // Deliberately styleless: no border, no radius, white on white. A note that looks
    // designed reads as marketing; this one should look like it was typed.
    theme: {
      pageBg: "#ffffff",
      contentBg: "#ffffff",
      textColor: "#1f2937",
      headingColor: "#111827",
      linkColor: "#1d4ed8",
      borderColor: "#ffffff",
      borderWidth: 0,
      imageRadius: 0,
      sectionRadius: 0,
    },
    build: () => [
      text(
        "<p>Hi {{first_name|there}},</p>" +
          "<p>Open with the thought itself — no preamble, no \"we're excited to announce\". One paragraph on what you noticed or decided.</p>" +
          "<p>Then a paragraph on what it means for them, in plain words.</p>" +
          "<p>Close with a real question. Replies come straight back to you, and people do answer this one.</p>" +
          "<p>— Your name<br>Founder, {{company_name}}</p>",
      ),
    ],
  },
  {
    key: "digest",
    name: "Weekly digest",
    description: "A short roundup of links worth someone's time.",
    structure: "Intro · 3 linked items · CTA · social row",
    subject: "This week: three things worth reading",
    previewText: "The short list, so you can skip the rest.",
    theme: {
      pageBg: "#faf7f2",
      contentBg: "#ffffff",
      textColor: "#292524",
      headingColor: "#1c1917",
      linkColor: "#b45309",
      borderColor: "#e7e5e4",
      borderWidth: 1,
      imageRadius: 6,
      sectionRadius: 8,
    },
    build: () => [
      text(
        "<h1>The {{company_name}} digest</h1>" +
          "<p>Hi {{first_name|there}} — three things worth your time this week.</p>",
      ),
      rule(),
      text(
        "<h3>First headline goes here</h3>" +
          "<p>One line on why it matters. Then link the headline to the full piece.</p>",
      ),
      text(
        "<h3>Second headline goes here</h3>" +
          "<p>Keep every item to a single line — a digest earns its opens by being short.</p>",
      ),
      text(
        "<h3>Third headline goes here</h3>" +
          "<p>Mixing in something you didn't write is what makes a digest worth subscribing to.</p>",
      ),
      button("Read the full archive", "#b45309"),
      social("Find us at:"),
    ],
  },
  {
    key: "event-invite",
    name: "Event invite",
    description: "A webinar, demo day, or office hours — details block plus RSVP.",
    structure: "Invite · details callout · full-width RSVP · can't-make-it note",
    subject: "You're invited: our next live session",
    previewText: "30 minutes, live, with time for questions at the end.",
    theme: {
      pageBg: "#ecfeff",
      contentBg: "#ffffff",
      textColor: "#164e63",
      headingColor: "#0f172a",
      linkColor: "#0891b2",
      borderColor: "#cffafe",
      borderWidth: 1,
      imageRadius: 10,
      sectionRadius: 16,
    },
    build: () => [
      text(
        "<h1>You're invited</h1>" +
          "<p>Hi {{first_name|there}},</p>" +
          "<p>One or two sentences on what the session covers and who should come. Be specific about what they'll leave knowing.</p>",
      ),
      quote(
        "<p><strong>When:</strong> Add the date and start time (with a timezone)<br>" +
          "<strong>How long:</strong> 30 minutes, including questions<br>" +
          "<strong>Where:</strong> Add the meeting link or location</p>",
        "#ecfeff",
      ),
      button("Save my seat", "#0891b2", { fullWidth: true }),
      columns([
        "<h4>What we'll cover</h4><p>Two or three bullets' worth, in a sentence.</p>",
        "<h4>Who it's for</h4><p>Name the role or the situation, so people can self-select.</p>",
      ]),
      rule(),
      text(
        "<p>Can't make it live? Reply and we'll send you the recording afterwards.</p>",
      ),
      social("Follow along:"),
    ],
  },
];

// Lookup by key, for applying a template chosen in the gallery. Returns undefined
// for an unknown key (a stale link or a removed template) so callers can no-op.
export function campaignTemplate(key: string): CampaignTemplate | undefined {
  return CAMPAIGN_TEMPLATES.find((t) => t.key === key);
}

// The section kinds a template is allowed to use. Not a runtime guard — it exists so
// the test suite fails loudly if a template starts leaning on a kind whose editor or
// serializer hasn't been considered here.
export const TEMPLATE_SECTION_KINDS: readonly SectionKind[] = [
  "text",
  "image",
  "button",
  "divider",
  "quote",
  "card",
  "social",
];
