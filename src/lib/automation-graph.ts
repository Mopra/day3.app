import { z } from "zod";
import { MAX_SERIALIZED_BODY_CHARS } from "./sections";
import { SegmentFilterSchema } from "./segment-filter-schema";

// The automation graph: the pure, database-free model of a canvas.
//
// An automation is a directed graph of nodes entered at one trigger. A single
// subscriber's progress through it is a cursor sitting on exactly one node, and
// every branching node routes that cursor down exactly one outgoing edge. That
// one constraint is what keeps a full canvas as cheap to execute as a linear
// list would have been: there is no join/merge semantics, no "wait for all
// inbound paths" state, and the enrollment cursor stays a single node key.
// Edges converging on a node are free (two nodes pointing at the same next
// node is not a merge).
//
// This module owns the vocabulary, the per-kind config schemas, and the
// publish-time validator. It is deliberately dependency-free of the database
// (like lib/segment-filter.ts) so the canvas, the API, and the worker all
// validate a graph with the same code.

/* ────────────────────────────── vocabulary ────────────────────────────── */

// Phase 1 node set. `wait_for` (wait up to N days for a condition), `split`
// (percentage A/B by deterministic hash) and `set_field` are Phase 2: each
// needs machinery beyond the executor's node dispatch, so they are added to
// this union, PORTS_BY_KIND and the config union together rather than stubbed
// here where the validator would have to pretend to understand them.
export const AUTOMATION_NODE_KINDS = ["trigger", "send", "wait", "branch", "end"] as const;
export type AutomationNodeKind = (typeof AUTOMATION_NODE_KINDS)[number];

// Every outgoing port in the vocabulary. A port is the *named* exit of a node;
// an edge is a port bound to a destination. A port with no edge simply ends the
// enrollment, which is why an unbound port is a warning and never an error.
export const NODE_PORTS = ["next", "yes", "no"] as const;
export type NodePort = (typeof NODE_PORTS)[number];

export const PORTS_BY_KIND: Record<AutomationNodeKind, readonly NodePort[]> = {
  trigger: ["next"],
  send: ["next"],
  wait: ["next"],
  branch: ["yes", "no"],
  end: [],
};

// Structural ceilings, not plan limits. They exist so the canvas stays readable
// and the publish validator stays instant, and they apply equally to every tier
// (comparable to the existing 25-segments / 20-topics caps). Hitting one means
// something has gone wrong, not that the customer has outgrown their plan.
export const MAX_AUTOMATION_NODES = 100;
export const MAX_AUTOMATIONS_PER_ACCOUNT = 50;

// Loop guards, per enrollment. These protect the *recipient* and are entirely
// separate from the fair-use rate ceiling, which protects our infrastructure.
// Exceeding either exits the enrollment with reason `loop_guard`.
export const DEFAULT_VISIT_CAP = 200;
export const DEFAULT_SEND_CAP = 50;

// Every cycle in the graph must pass through a wait of at least this long, so a
// tight infinite loop is unrepresentable rather than merely discouraged.
export const MIN_CYCLE_WAIT_MS = 60 * 60 * 1000;

/* ──────────────────────────── node configs ────────────────────────────── */

export const WAIT_UNITS = ["minutes", "hours", "days"] as const;
export type WaitUnit = (typeof WAIT_UNITS)[number];

const UNIT_MS: Record<WaitUnit, number> = {
  minutes: 60 * 1000,
  hours: 60 * 60 * 1000,
  days: 24 * 60 * 60 * 1000,
};

// A year is the outer bound on a single wait. Longer than that and the
// subscriber has almost certainly churned; the enrollment would sit in the
// table costing an index entry for nothing.
export const MAX_WAIT_MS = 365 * UNIT_MS.days;

export const WaitNodeConfigSchema = z
  .object({
    value: z.number().int().min(1).max(100_000),
    unit: z.enum(WAIT_UNITS),
    // Push the due time into the automation's send window (a working-hours
    // clamp, see automations.sendWindowJson). Only ever delays, never advances,
    // so it can't shorten a cycle below MIN_CYCLE_WAIT_MS.
    clampToSendWindow: z.boolean().default(false),
  })
  .refine((c) => c.value * UNIT_MS[c.unit] <= MAX_WAIT_MS, {
    message: "A wait may be at most 365 days",
  });
export type WaitNodeConfig = z.infer<typeof WaitNodeConfigSchema>;

export function waitMillis(config: WaitNodeConfig): number {
  return config.value * UNIT_MS[config.unit];
}

// What a branch tests. Filters reuse the saved-segment model verbatim: the same
// builder component, the same Zod schema, the same segmentFilterCondition() SQL
// the Segments tab already runs. Engagement predicates read this automation's
// own earlier sends off the send ledger, so they cost one indexed lookup.
export const ENGAGEMENT_EVENTS = ["opened", "not_opened", "clicked", "not_clicked"] as const;
export type EngagementEvent = (typeof ENGAGEMENT_EVENTS)[number];

// Node keys are the stable logical identity of a node, minted once in the draft
// and copied verbatim into every published version (unlike the per-version row
// id). Stats, engagement predicates and in-flight cursor migration all key off
// this, which is what lets "move people to the new version" map a cursor at all.
const NODE_KEY_RE = /^nd_[0-9a-z]{1,40}$/;
const NodeKeySchema = z.string().regex(NODE_KEY_RE, "Invalid node key");

export const BranchConditionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("filter"), filter: SegmentFilterSchema }),
  z.object({
    kind: z.literal("engagement"),
    event: z.enum(ENGAGEMENT_EVENTS),
    // The send node the predicate is about. Null means "any send node in this
    // automation", which is how "hasn't clicked anything yet" is expressed.
    nodeKey: NodeKeySchema.nullable().default(null),
  }),
]);
export type BranchCondition = z.infer<typeof BranchConditionSchema>;

export const BranchNodeConfigSchema = z.object({ condition: BranchConditionSchema });
export type BranchNodeConfig = z.infer<typeof BranchNodeConfigSchema>;

// A send node holds a whole email, authored by the real composer, so
// lib/sections.ts, lib/theme.ts and services/render.ts are reused unchanged.
// htmlBody stays the send-authoritative body derived server-side from
// sectionsJson, exactly as on a campaign row.
export const SendNodeConfigSchema = z.object({
  subject: z.string().max(500),
  previewText: z.string().max(500).nullable().default(null),
  sectionsJson: z.string().max(MAX_SERIALIZED_BODY_CHARS).nullable().default(null),
  htmlBody: z.string().max(MAX_SERIALIZED_BODY_CHARS),
  textBody: z.string().max(MAX_SERIALIZED_BODY_CHARS).nullable().default(null),
  // Off by default, and deliberately so. The send ledger keys a send on
  // (enrollment, node, visit), so a looping send node would otherwise be
  // blocked from ever re-sending. Turning this on is how a genuine recurring
  // nudge is expressed; leaving it off is what stops an accidental cycle from
  // mailing someone the same thing twice.
  allowResend: z.boolean().default(false),
});
export type SendNodeConfig = z.infer<typeof SendNodeConfigSchema>;

// Trigger and End carry no config of their own: what fires the automation lives
// on the `automations` row (trigger kind, segment/topic/form narrowing, entry
// filter) because the entry condition has to be queryable without loading a
// graph, and End is pure punctuation on the canvas.
export const EmptyNodeConfigSchema = z.object({}).strict();

export const NODE_CONFIG_SCHEMAS = {
  trigger: EmptyNodeConfigSchema,
  send: SendNodeConfigSchema,
  wait: WaitNodeConfigSchema,
  branch: BranchNodeConfigSchema,
  end: EmptyNodeConfigSchema,
} as const;

export type AutomationNodeConfig =
  | z.infer<typeof EmptyNodeConfigSchema>
  | SendNodeConfig
  | WaitNodeConfig
  | BranchNodeConfig;

/* ─────────────────────────────── the graph ────────────────────────────── */

export type AutomationGraphNode = {
  key: string;
  kind: AutomationNodeKind;
  /** Validated by the per-kind schema above; unknown here so a draft can hold a half-edited node. */
  config: unknown;
  /** User-facing name, shown on the canvas and used in engagement predicates. */
  label?: string | null;
};

export type AutomationGraphEdge = {
  fromKey: string;
  port: NodePort;
  toKey: string;
};

// The graph as the engine and the validator see it: keys only. Row ids, version
// ids and canvas coordinates are storage/presentation concerns that never reach
// this model, which is exactly why coordinates live on the node row (they are
// the only part of the graph the engine never reads).
export type AutomationGraph = {
  nodes: AutomationGraphNode[];
  edges: AutomationGraphEdge[];
};

// The destination of one port, or null when the port is unbound (which ends the
// enrollment). The engine's whole routing step is this function.
export function nextNodeKey(
  graph: AutomationGraph,
  fromKey: string,
  port: NodePort,
): string | null {
  const edge = graph.edges.find((e) => e.fromKey === fromKey && e.port === port);
  return edge ? edge.toKey : null;
}

export function findNode(graph: AutomationGraph, key: string): AutomationGraphNode | null {
  return graph.nodes.find((n) => n.key === key) ?? null;
}

export function triggerNode(graph: AutomationGraph): AutomationGraphNode | null {
  return graph.nodes.find((n) => n.kind === "trigger") ?? null;
}

/* ───────────────────────────── validation ─────────────────────────────── */

// Drafts are allowed to be broken mid-edit. Publish is the gate, and it
// distinguishes two kinds of problem: an error means the graph cannot run
// correctly, a warning means it will run but probably not as drawn (people
// leave scratch nodes off to the side, and an unbound port is a legitimate way
// to end a flow).
export type GraphIssueCode =
  | "no_trigger"
  | "multiple_triggers"
  | "too_many_nodes"
  | "duplicate_node_key"
  | "unknown_node_kind"
  | "invalid_config"
  | "unknown_edge_node"
  | "invalid_port"
  | "duplicate_port_edge"
  | "self_edge"
  | "send_missing_content"
  | "unknown_engagement_target"
  | "cycle_without_wait"
  | "unreachable_node"
  | "unbound_port"
  | "branch_both_ports_same";

export type GraphIssue = {
  code: GraphIssueCode;
  message: string;
  /** The node the issue is about, when it is about one. */
  nodeKey?: string;
};

export type GraphValidation = {
  errors: GraphIssue[];
  warnings: GraphIssue[];
  ok: boolean;
};

export function validateGraph(graph: AutomationGraph): GraphValidation {
  const errors: GraphIssue[] = [];
  const warnings: GraphIssue[] = [];
  const err = (code: GraphIssueCode, message: string, nodeKey?: string) =>
    errors.push({ code, message, ...(nodeKey ? { nodeKey } : {}) });
  const warn = (code: GraphIssueCode, message: string, nodeKey?: string) =>
    warnings.push({ code, message, ...(nodeKey ? { nodeKey } : {}) });

  /* nodes */

  if (graph.nodes.length > MAX_AUTOMATION_NODES) {
    err(
      "too_many_nodes",
      `An automation can have at most ${MAX_AUTOMATION_NODES} nodes (this one has ${graph.nodes.length}).`,
    );
  }

  const byKey = new Map<string, AutomationGraphNode>();
  for (const node of graph.nodes) {
    if (byKey.has(node.key)) {
      err("duplicate_node_key", `Two nodes share the id ${node.key}.`, node.key);
      continue;
    }
    byKey.set(node.key, node);
  }

  const triggers = graph.nodes.filter((n) => n.kind === "trigger");
  if (triggers.length === 0) {
    err("no_trigger", "Add a trigger: an automation needs somewhere to start.");
  } else if (triggers.length > 1) {
    // One entry point keeps the cursor model and the validator simple. "Joins
    // the audience OR I enroll them from my backend" does not need a second
    // trigger node: the /enroll endpoint can enroll into any automation
    // regardless of what its trigger says.
    err("multiple_triggers", "An automation can only have one trigger.", triggers[1].key);
  }

  const sendKeys = new Set<string>();
  for (const node of byKey.values()) {
    const schema = NODE_CONFIG_SCHEMAS[node.kind];
    if (!schema) {
      err("unknown_node_kind", `"${node.kind}" is not a node type.`, node.key);
      continue;
    }
    const parsed = schema.safeParse(node.config ?? {});
    if (!parsed.success) {
      err("invalid_config", `${nodeTitle(node)} is not fully configured.`, node.key);
      continue;
    }
    if (node.kind === "send") {
      sendKeys.add(node.key);
      const config = parsed.data as SendNodeConfig;
      if (!config.subject.trim() || !config.htmlBody.trim()) {
        err(
          "send_missing_content",
          `${nodeTitle(node)} needs a subject line and some content before it can send.`,
          node.key,
        );
      }
    }
  }

  // Engagement predicates are checked after the send set is known, so a branch
  // may legally reference a send node drawn later on the canvas.
  for (const node of byKey.values()) {
    if (node.kind !== "branch") continue;
    const parsed = BranchNodeConfigSchema.safeParse(node.config ?? {});
    if (!parsed.success) continue; // already reported as invalid_config
    const condition = parsed.data.condition;
    if (condition.kind === "engagement" && condition.nodeKey && !sendKeys.has(condition.nodeKey)) {
      err(
        "unknown_engagement_target",
        `${nodeTitle(node)} asks about an email that is no longer in this automation.`,
        node.key,
      );
    }
  }

  /* edges */

  const seenPorts = new Set<string>();
  for (const edge of graph.edges) {
    const from = byKey.get(edge.fromKey);
    const to = byKey.get(edge.toKey);
    if (!from || !to) {
      err("unknown_edge_node", "A connection points at a step that no longer exists.");
      continue;
    }
    if (!PORTS_BY_KIND[from.kind]?.includes(edge.port)) {
      err("invalid_port", `${nodeTitle(from)} has no "${edge.port}" output.`, from.key);
      continue;
    }
    const portKey = `${edge.fromKey}:${edge.port}`;
    if (seenPorts.has(portKey)) {
      // One destination per port is the invariant behind the single-cursor
      // model: two edges out of one port would mean splitting the token.
      err(
        "duplicate_port_edge",
        `${nodeTitle(from)} has two connections from the same output.`,
        from.key,
      );
      continue;
    }
    seenPorts.add(portKey);
    if (edge.fromKey === edge.toKey) {
      err("self_edge", `${nodeTitle(from)} connects to itself.`, from.key);
    }
  }

  /* reachability, cycles, and the soft stuff */

  const entry = triggers[0];
  if (entry) {
    const reachable = reachableFrom(graph, entry.key);
    for (const node of byKey.values()) {
      if (!reachable.has(node.key)) {
        warn("unreachable_node", `${nodeTitle(node)} is not connected to the flow.`, node.key);
      }
    }
  }

  // A loop is a legitimate thing to draw ("wait 30 days, re-check, nudge
  // again"), so cycles are permitted rather than blocked. What is not permitted
  // is a cycle that can spin without time passing. Checking strongly-connected
  // components rather than enumerating cycles keeps this O(V+E): enumerating
  // every cycle in a graph is exponential, and the answer is the same, since a
  // qualifying wait anywhere in an SCC delays every cycle through it.
  for (const component of stronglyConnectedComponents(graph)) {
    if (!componentCycles(graph, component)) continue;
    const hasSlowWait = component.some((key) => {
      const node = byKey.get(key);
      if (!node || node.kind !== "wait") return false;
      const parsed = WaitNodeConfigSchema.safeParse(node.config ?? {});
      return parsed.success && waitMillis(parsed.data) >= MIN_CYCLE_WAIT_MS;
    });
    if (!hasSlowWait) {
      err(
        "cycle_without_wait",
        "This flow loops back on itself without waiting. Add a wait of at least an hour inside the loop.",
        component[0],
      );
    }
  }

  for (const node of byKey.values()) {
    for (const port of PORTS_BY_KIND[node.kind] ?? []) {
      if (!seenPorts.has(`${node.key}:${port}`)) {
        warn(
          "unbound_port",
          node.kind === "branch"
            ? `${nodeTitle(node)} ends the flow on "${port}".`
            : `${nodeTitle(node)} is the end of the flow.`,
          node.key,
        );
      }
    }
    if (node.kind === "branch") {
      const yes = nextNodeKey(graph, node.key, "yes");
      const no = nextNodeKey(graph, node.key, "no");
      if (yes && no && yes === no) {
        warn(
          "branch_both_ports_same",
          `${nodeTitle(node)} sends both answers to the same step, so it has no effect.`,
          node.key,
        );
      }
    }
  }

  return { errors, warnings, ok: errors.length === 0 };
}

/* ───────────────────────────── graph theory ───────────────────────────── */

export function reachableFrom(graph: AutomationGraph, startKey: string): Set<string> {
  const out = adjacency(graph);
  const seen = new Set<string>([startKey]);
  const stack = [startKey];
  while (stack.length > 0) {
    const key = stack.pop()!;
    for (const next of out.get(key) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        stack.push(next);
      }
    }
  }
  return seen;
}

function adjacency(graph: AutomationGraph): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of graph.nodes) out.set(node.key, []);
  for (const edge of graph.edges) {
    if (!out.has(edge.fromKey) || !out.has(edge.toKey)) continue;
    out.get(edge.fromKey)!.push(edge.toKey);
  }
  return out;
}

// Tarjan's algorithm, iterative so a 100-node canvas can never blow the stack
// on a pathological chain. Returns every strongly-connected component,
// including the single-node ones (a component of one is only a cycle if the
// node has an edge to itself, which componentCycles decides).
export function stronglyConnectedComponents(graph: AutomationGraph): string[][] {
  const out = adjacency(graph);
  const index = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let counter = 0;

  for (const root of out.keys()) {
    if (index.has(root)) continue;
    // Each frame is a node plus how far through its successors we are.
    const frames: { key: string; edge: number }[] = [{ key: root, edge: 0 }];
    index.set(root, counter);
    low.set(root, counter);
    counter++;
    stack.push(root);
    onStack.add(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const successors = out.get(frame.key) ?? [];
      if (frame.edge < successors.length) {
        const next = successors[frame.edge++];
        if (!index.has(next)) {
          index.set(next, counter);
          low.set(next, counter);
          counter++;
          stack.push(next);
          onStack.add(next);
          frames.push({ key: next, edge: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.key, Math.min(low.get(frame.key)!, index.get(next)!));
        }
        continue;
      }
      frames.pop();
      if (frames.length > 0) {
        const parent = frames[frames.length - 1];
        low.set(parent.key, Math.min(low.get(parent.key)!, low.get(frame.key)!));
      }
      if (low.get(frame.key) === index.get(frame.key)) {
        const component: string[] = [];
        for (;;) {
          const key = stack.pop()!;
          onStack.delete(key);
          component.push(key);
          if (key === frame.key) break;
        }
        components.push(component);
      }
    }
  }
  return components;
}

// Whether a component actually contains a cycle. Every multi-node SCC does by
// definition; a single-node one does only if it loops back to itself.
function componentCycles(graph: AutomationGraph, component: string[]): boolean {
  if (component.length > 1) return true;
  const only = component[0];
  return graph.edges.some((e) => e.fromKey === only && e.toKey === only);
}

/* ─────────────────────────────── outline ──────────────────────────────── */

// The graph as prose: the same information the canvas draws, as an indented
// outline. It is how you review a flow you did not build, how support reasons
// about a customer's setup, and how the AI assistant describes or generates
// one. Pure text, so it is also the cheapest thing to assert on in a test.
export function graphOutline(graph: AutomationGraph): string {
  const entry = triggerNode(graph);
  if (!entry) return "(no trigger)";
  const lines: string[] = [];
  const seen = new Set<string>();

  const walk = (key: string, depth: number, portLabel: string | null) => {
    const node = findNode(graph, key);
    const indent = "  ".repeat(depth);
    const prefix = portLabel ? `${indent}${portLabel}: ` : indent;
    if (!node) {
      lines.push(`${prefix}(missing step)`);
      return;
    }
    if (seen.has(key)) {
      lines.push(`${prefix}↩ back to ${nodeTitle(node)}`);
      return;
    }
    seen.add(key);
    lines.push(`${prefix}${nodeTitle(node)}`);

    const ports = PORTS_BY_KIND[node.kind] ?? [];
    for (const port of ports) {
      const next = nextNodeKey(graph, key, port);
      const branching = ports.length > 1;
      if (!next) {
        if (branching) lines.push(`${"  ".repeat(depth + 1)}${port}: End`);
        continue;
      }
      walk(next, branching ? depth + 1 : depth, branching ? port : null);
    }
  };

  walk(entry.key, 0, null);
  return lines.join("\n");
}

// A node's human name: whatever the user called it, else a description derived
// from its config, else the kind. Used in the outline and in every validation
// message, so a customer reads "Welcome email needs a subject line" rather than
// a node id.
export function nodeTitle(node: AutomationGraphNode): string {
  if (node.label && node.label.trim()) return node.label.trim();
  switch (node.kind) {
    case "trigger":
      return "Trigger";
    case "end":
      return "End";
    case "send": {
      const parsed = SendNodeConfigSchema.safeParse(node.config ?? {});
      const subject = parsed.success ? parsed.data.subject.trim() : "";
      return subject ? `Email "${subject}"` : "Email";
    }
    case "wait": {
      const parsed = WaitNodeConfigSchema.safeParse(node.config ?? {});
      if (!parsed.success) return "Wait";
      const { value, unit } = parsed.data;
      return `Wait ${value} ${value === 1 ? unit.replace(/s$/, "") : unit}`;
    }
    case "branch":
      return "If";
  }
}
