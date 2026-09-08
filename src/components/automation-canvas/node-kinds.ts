import type { LucideIcon } from "lucide-react";
import { Clock, Flag, GitFork, Mail, Zap } from "lucide-react";
import {
  BranchNodeConfigSchema,
  ENGAGEMENT_EVENTS,
  SendNodeConfigSchema,
  WaitNodeConfigSchema,
  nodeTitle,
  type AutomationGraph,
  type AutomationNodeKind,
  type EngagementEvent,
} from "@/lib/automation-graph";
import type { DraftGraphInput, GraphPayload, GraphPayloadNode } from "@/lib/automation-types";
import { OP_LABELS } from "./segment-filter-builder";

// The canvas's view of the node vocabulary: how each kind looks and what a
// brand-new one starts as. The vocabulary itself (kinds, ports, config schemas)
// stays in lib/automation-graph.ts; this file only adds presentation.

export type KindMeta = {
  label: string;
  icon: LucideIcon;
  // Accent ink for the icon. Brand hues on accents only: olive for the entry,
  // caramel for mail in flight, neutral for the plumbing.
  tone: string;
  blurb: string;
};

export const KIND_META: Record<AutomationNodeKind, KindMeta> = {
  trigger: {
    label: "Trigger",
    icon: Zap,
    tone: "text-olive",
    blurb: "Where people enter the flow.",
  },
  send: {
    label: "Email",
    icon: Mail,
    tone: "text-caramel",
    blurb: "Send an email, written in the composer.",
  },
  wait: {
    label: "Wait",
    icon: Clock,
    tone: "text-muted-foreground",
    blurb: "Pause for a while before the next step.",
  },
  branch: {
    label: "If",
    icon: GitFork,
    tone: "text-muted-foreground",
    blurb: "Split on a contact filter or on engagement.",
  },
  end: {
    label: "End",
    icon: Flag,
    tone: "text-muted-foreground",
    blurb: "Stop the flow here.",
  },
};

// The kinds a user can add. The trigger is created with the automation and there
// is exactly one, so it is never on the menu.
export const ADDABLE_KINDS: AutomationNodeKind[] = ["send", "wait", "branch", "end"];

// Node keys are minted client-side so the canvas can reference a node (edges,
// selection, engagement predicates) before it has ever been saved. Format is
// NODE_KEY_RE in lib/automation-graph.ts.
export function mintNodeKey(): string {
  const alphabet = "0123456789abcdefghijklmnopqrstuvwxyz";
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let out = "nd_";
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
}

// What a freshly-added node holds. Each is the smallest config the per-kind
// schema accepts, so a new node is "not fully configured" only where it needs
// the user's words (a send's subject and body), never because of a shape error.
export function defaultConfig(kind: AutomationNodeKind): unknown {
  switch (kind) {
    case "send":
      return {
        subject: "",
        previewText: null,
        sectionsJson: null,
        htmlBody: "",
        textBody: null,
        allowResend: false,
      };
    case "wait":
      return { value: 1, unit: "days", clampToSendWindow: false };
    case "branch":
      // "email has any value" is true for every contact: a valid, harmless
      // placeholder until the user picks a real condition.
      return {
        condition: {
          kind: "filter",
          filter: { match: "all", conditions: [{ field: "email", op: "is_set" }] },
        },
      };
    default:
      return {};
  }
}

export const ENGAGEMENT_LABELS: Record<EngagementEvent, string> = {
  opened: "opened",
  not_opened: "did not open",
  clicked: "clicked",
  not_clicked: "did not click",
};

export { ENGAGEMENT_EVENTS };

// One line under the node title saying what the node will do, derived from its
// config. Empty string when there is nothing useful to say.
export function nodeSummary(node: GraphPayloadNode, all: GraphPayloadNode[]): string {
  switch (node.kind) {
    case "send": {
      const parsed = SendNodeConfigSchema.safeParse(node.config ?? {});
      if (!parsed.success) return "Needs a subject and content";
      const subject = parsed.data.subject.trim();
      if (!subject) return "No subject yet";
      // The title already shows the subject when the node has no label.
      return node.label?.trim() ? subject : parsed.data.previewText?.trim() || "";
    }
    case "wait": {
      const parsed = WaitNodeConfigSchema.safeParse(node.config ?? {});
      if (!parsed.success) return "Needs a duration";
      return parsed.data.clampToSendWindow ? "Then only during the send window" : "";
    }
    case "branch": {
      const parsed = BranchNodeConfigSchema.safeParse(node.config ?? {});
      if (!parsed.success) return "Needs a condition";
      const c = parsed.data.condition;
      if (c.kind === "engagement") {
        const target = c.nodeKey ? all.find((n) => n.key === c.nodeKey) : null;
        const what = c.nodeKey ? (target ? nodeTitle(target) : "a removed email") : "any email";
        return `${ENGAGEMENT_LABELS[c.event]} ${what}`;
      }
      const first = c.filter.conditions[0];
      const rest = c.filter.conditions.length - 1;
      const head = `${first.field.replace(/_/g, " ")} ${OP_LABELS[first.op]}${
        first.value ? ` ${first.value}` : ""
      }`;
      return rest > 0 ? `${head} (+${rest} more)` : head;
    }
    case "trigger":
      return "";
    case "end":
      return "";
  }
}

// The payload the canvas edits is the payload the API returns, minus the fields
// only a published version carries (risk). This strips it down to the PUT body.
export function toDraftInput(payload: GraphPayload): DraftGraphInput {
  return {
    nodes: payload.nodes.map((n) => ({
      key: n.key,
      kind: n.kind,
      config: n.config,
      label: n.label,
      x: Math.round(n.x),
      y: Math.round(n.y),
    })),
    edges: payload.edges.map((e) => ({ fromKey: e.fromKey, port: e.port, toKey: e.toKey })),
  };
}

// The keys-only graph the validator and the outline read.
export function toGraph(payload: Pick<GraphPayload, "nodes" | "edges">): AutomationGraph {
  return {
    nodes: payload.nodes.map((n) => ({
      key: n.key,
      kind: n.kind,
      config: n.config,
      label: n.label,
    })),
    edges: payload.edges,
  };
}

// True when the stored coordinates carry no layout (every node at the origin, or
// all stacked on one point), which is what a freshly-created draft looks like.
export function needsLayout(nodes: GraphPayloadNode[]): boolean {
  if (nodes.length < 2) return false;
  const first = nodes[0];
  return nodes.every((n) => n.x === first.x && n.y === first.y);
}
