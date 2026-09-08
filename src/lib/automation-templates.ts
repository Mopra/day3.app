// Ready-made automation starting points. A template is *pure data*: a node list
// with canvas coordinates and real draft copy, plus the edges that wire it. It
// needs no table and no migration; applying one is exactly the same operation as
// the canvas saving a draft (see services/automations createAutomation), which is
// why `build()` returns a DraftGraphInput rather than some private shape.
//
// Why copy is written out rather than left as placeholders: a blank canvas is
// where a non-technical founder quits (docs/automations-design.md §8). Every send
// node here is a complete, sendable email that reads well as-is, so "publish the
// welcome template" is a legitimate first run rather than a to-do list.
//
// Send-node content reuses the campaign section builder verbatim, and htmlBody
// is derived from the sections by the same serializer campaigns use, so template
// emails stay editable in the composer and are email-safe by construction.
// Buttons ship with a label but no href, mirroring lib/campaign-templates.ts: the
// serializer skips a button until it has a real link, so an unfinished template
// never ships a dead call to action. Merge tags always carry a fallback.
//
// Node keys are minted fresh on every build() (newId("nd")), because a key is a
// node's stable identity for the life of the automation and two automations
// must never share one.
import type { BranchNodeConfig, SendNodeConfig, WaitNodeConfig } from "./automation-graph";
import type {
  AutomationTemplateSummary,
  DraftGraphInput,
  GraphPayloadEdge,
} from "./automation-types";
import { newId } from "./ids";
import { newSectionId, serializeSections, type CampaignSection } from "./sections";

export type AutomationTemplate = {
  /** Stable identifier, sent as CreateAutomationInput.templateKey. */
  key: string;
  name: string;
  /** One line on what the flow is for, shown in the picker. */
  description: string;
  /** Built fresh on every call so each application mints new node keys. */
  build: () => DraftGraphInput;
};

/* ─────────────────────────── layout constants ─────────────────────────── */

// A top-down column: every node is X_MAIN except branch arms, which fan out to
// the left (yes) and right (no). Node cards are roughly 260px wide on the canvas,
// so the arm offset keeps sibling arms from overlapping without a layout pass.
const X_MAIN = 0;
const X_YES = -180;
const X_NO = 180;
const ROW = 150;

/* ───────────────────────────── node builders ──────────────────────────── */

type DraftNode = DraftGraphInput["nodes"][number];

function trigger(y: number): DraftNode {
  return { key: newId("nd"), kind: "trigger", config: {}, label: null, x: X_MAIN, y };
}

function end(y: number, x: number = X_MAIN): DraftNode {
  return { key: newId("nd"), kind: "end", config: {}, label: null, x, y };
}

function wait(value: number, unit: WaitNodeConfig["unit"], y: number): DraftNode {
  const config: WaitNodeConfig = { value, unit, clampToSendWindow: false };
  return { key: newId("nd"), kind: "wait", config, label: null, x: X_MAIN, y };
}

function branch(label: string, condition: BranchNodeConfig["condition"], y: number): DraftNode {
  const config: BranchNodeConfig = { condition };
  return { key: newId("nd"), kind: "branch", config, label, x: X_MAIN, y };
}

function send(
  label: string,
  email: { subject: string; previewText: string; sections: CampaignSection[] },
  y: number,
  x: number = X_MAIN,
): DraftNode {
  const config: SendNodeConfig = {
    subject: email.subject,
    previewText: email.previewText,
    sectionsJson: JSON.stringify(email.sections),
    htmlBody: serializeSections(email.sections),
    textBody: null,
    allowResend: false,
  };
  return { key: newId("nd"), kind: "send", config, label, x, y };
}

function edge(from: DraftNode, to: DraftNode, port: GraphPayloadEdge["port"] = "next"): GraphPayloadEdge {
  return { fromKey: from.key, port, toKey: to.key };
}

/* ──────────────────────────── section helpers ─────────────────────────── */

function text(html: string): CampaignSection {
  return { id: newSectionId(), kind: "text", columns: 1, content: [html] };
}

function button(label: string): CampaignSection {
  return {
    id: newSectionId(),
    kind: "button",
    columns: 1,
    content: [""],
    align: "center",
    buttons: [{ label, href: "" }],
  };
}

/* ────────────────────────────── the copy ──────────────────────────────── */

// Each email is short, warm and professional, and stands on its own: a founder
// can publish it unchanged and nothing in it will read as a placeholder.

const WELCOME_EMAIL = () => ({
  subject: "Welcome, {{first_name|and thanks for joining}}",
  previewText: "Here is what to expect from us, and where to start.",
  sections: [
    text(
      "<h1>Welcome aboard</h1>" +
        "<p>Hi {{first_name|there}},</p>" +
        "<p>Thanks for signing up. You will hear from us when there is something worth your time: a new feature, a useful guide, or a change that affects how you work. Never more than that.</p>" +
        "<p>If you want to get going right now, the best first step is below.</p>",
    ),
    button("Get started"),
    text("<p>Questions? Just reply to this email. A real person reads every one.</p>"),
  ],
});

const WELCOME_SERIES_TWO = () => ({
  subject: "One thing most people miss at the start",
  previewText: "A small setup step that saves a lot of time later.",
  sections: [
    text(
      "<h2>A quick tip for your first week</h2>" +
        "<p>Hi {{first_name|there}},</p>" +
        "<p>Most people who get real value in the first week do one thing early: they connect the tool to the work they already do. It takes a few minutes and makes everything after it feel like it fits.</p>" +
        "<p>Here is how to do it.</p>",
    ),
    button("Set it up"),
  ],
});

const WELCOME_SERIES_THREE = () => ({
  subject: "How others are using it",
  previewText: "Three real examples, none of them longer than a paragraph.",
  sections: [
    text(
      "<h2>Three ways people use this</h2>" +
        "<p>Hi {{first_name|there}},</p>" +
        "<p>By now you have had a look around. Here are three short examples of how other teams put it to work. Steal whichever one is closest to your situation.</p>" +
        "<p><strong>Keep it small.</strong> One team started with a single weekly update and never needed more.</p>" +
        "<p><strong>Automate the boring part.</strong> Another set it up once and has not touched it since.</p>" +
        "<p><strong>Ask for replies.</strong> The third treats every send as the start of a conversation.</p>" +
        "<p>If none of these fit, reply and tell us what you are trying to do. We will point you in the right direction.</p>",
    ),
  ],
});

const TRIAL_START_EMAIL = () => ({
  subject: "Your trial has started",
  previewText: "Everything is unlocked. Here is the fastest way to see if it fits.",
  sections: [
    text(
      "<h1>Your trial is live</h1>" +
        "<p>Hi {{first_name|there}},</p>" +
        "<p>Everything is unlocked for the length of your trial, so you can judge it on the real thing rather than a demo.</p>" +
        "<p>The fastest way to find out whether it fits is to run one real task through it today. The button below takes you straight there.</p>",
    ),
    button("Run your first task"),
    text("<p>Stuck at any point? Reply to this email and we will help you through it.</p>"),
  ],
});

const TRIAL_UPGRADE_EMAIL = () => ({
  subject: "Ready to keep going?",
  previewText: "Your trial is under way. Here is what the paid plan adds.",
  sections: [
    text(
      "<h2>Keep what you have set up</h2>" +
        "<p>Hi {{first_name|there}},</p>" +
        "<p>You have had a day with the full product. If it is working for you, upgrading keeps everything you have set up exactly as it is, with no migration and no downtime.</p>" +
        "<p>The paid plan adds higher limits, priority support, and the features teams reach for once they are past the trial stage.</p>",
    ),
    button("See plans"),
    text("<p>Not ready yet? That is fine. Your trial continues, and this is the only nudge you will get from this series.</p>"),
  ],
});

const WIN_BACK_EMAIL = () => ({
  subject: "Still useful to you?",
  previewText: "It has been a while. Here is what changed, and an easy way out if not.",
  sections: [
    text(
      "<h2>It has been a while</h2>" +
        "<p>Hi {{first_name|there}},</p>" +
        "<p>We noticed you have not been around lately, and we would rather ask than guess. A lot has changed since you last looked, and some of it may be exactly what you were missing.</p>" +
        "<p>Have a quick look. If it is still not for you, the unsubscribe link at the bottom works with one click, no questions asked.</p>",
    ),
    button("See what is new"),
  ],
});

const WIN_BACK_SECOND_EMAIL = () => ({
  subject: "One last note from us",
  previewText: "We will stop here unless you want to hear more.",
  sections: [
    text(
      "<h2>Last one, we promise</h2>" +
        "<p>Hi {{first_name|there}},</p>" +
        "<p>We sent a note a few days ago and did not want to leave it at that. If there is something that would make this worth your time again, reply and tell us. We read every message.</p>" +
        "<p>Otherwise this is the last you will hear from this series, and we hope things are going well on your side.</p>",
    ),
  ],
});

/* ────────────────────────────── templates ─────────────────────────────── */

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  {
    key: "welcome",
    name: "Welcome email",
    description: "One email the moment someone joins. The 80% case.",
    build: () => {
      const t = trigger(0);
      const s = send("Welcome email", WELCOME_EMAIL(), ROW);
      const e = end(ROW * 2);
      return { nodes: [t, s, e], edges: [edge(t, s), edge(s, e)] };
    },
  },
  {
    key: "welcome-series",
    name: "Welcome series",
    description: "Three emails over the first week, spaced a few days apart.",
    build: () => {
      const t = trigger(0);
      const s1 = send("Welcome email", WELCOME_EMAIL(), ROW);
      const w1 = wait(2, "days", ROW * 2);
      const s2 = send("First-week tip", WELCOME_SERIES_TWO(), ROW * 3);
      const w2 = wait(3, "days", ROW * 4);
      const s3 = send("How others use it", WELCOME_SERIES_THREE(), ROW * 5);
      const e = end(ROW * 6);
      return {
        nodes: [t, s1, w1, s2, w2, s3, e],
        edges: [edge(t, s1), edge(s1, w1), edge(w1, s2), edge(s2, w2), edge(w2, s3), edge(s3, e)],
      };
    },
  },
  {
    key: "trial-onboarding",
    name: "Trial onboarding",
    description: "A start email, then an upgrade nudge only for people who have not upgraded.",
    build: () => {
      const t = trigger(0);
      const s1 = send("Trial started", TRIAL_START_EMAIL(), ROW);
      const w = wait(1, "days", ROW * 2);
      // The `plan` attribute is a placeholder for whatever field the customer's
      // signup form or API writes; the branch editor shows it as a real, editable
      // filter so the intent ("skip people who already pay") survives the swap.
      const b = branch(
        "Already on Pro?",
        {
          kind: "filter",
          filter: { match: "all", conditions: [{ field: "plan", op: "equals", value: "pro" }] },
        },
        ROW * 3,
      );
      const eYes = end(ROW * 4, X_YES);
      const s2 = send("Upgrade nudge", TRIAL_UPGRADE_EMAIL(), ROW * 4, X_NO);
      const eNo = end(ROW * 5, X_NO);
      return {
        nodes: [t, s1, w, b, eYes, s2, eNo],
        edges: [
          edge(t, s1),
          edge(s1, w),
          edge(w, b),
          edge(b, eYes, "yes"),
          edge(b, s2, "no"),
          edge(s2, eNo),
        ],
      };
    },
  },
  {
    key: "win-back",
    name: "Win back inactive subscribers",
    description: "A check-in email, and a second try only for people who did not open it.",
    build: () => {
      const t = trigger(0);
      const s1 = send("Check-in", WIN_BACK_EMAIL(), ROW);
      const w = wait(3, "days", ROW * 2);
      const b = branch(
        "Did not open the check-in?",
        { kind: "engagement", event: "not_opened", nodeKey: s1.key },
        ROW * 3,
      );
      const s2 = send("Second try", WIN_BACK_SECOND_EMAIL(), ROW * 4, X_YES);
      const eYes = end(ROW * 5, X_YES);
      const eNo = end(ROW * 4, X_NO);
      return {
        nodes: [t, s1, w, b, s2, eYes, eNo],
        edges: [
          edge(t, s1),
          edge(s1, w),
          edge(w, b),
          edge(b, s2, "yes"),
          edge(s2, eYes),
          edge(b, eNo, "no"),
        ],
      };
    },
  },
];

// The picker's catalogue. Node counts are computed from a build rather than
// hand-maintained so they cannot drift from the graph.
export function templateSummaries(): AutomationTemplateSummary[] {
  return AUTOMATION_TEMPLATES.map((t) => ({
    key: t.key,
    name: t.name,
    description: t.description,
    nodeCount: t.build().nodes.length,
  }));
}

// A fresh graph for the template, or null for an unknown key (the caller decides
// whether that is a 400 or a fallback to the blank canvas).
export function buildTemplateGraph(key: string): DraftGraphInput | null {
  const template = AUTOMATION_TEMPLATES.find((t) => t.key === key);
  return template ? template.build() : null;
}
