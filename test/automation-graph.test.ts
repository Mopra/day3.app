import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  MAX_AUTOMATION_NODES,
  graphOutline,
  nextNodeKey,
  stronglyConnectedComponents,
  validateGraph,
  waitMillis,
  type AutomationGraph,
  type AutomationGraphEdge,
  type AutomationGraphNode,
  type GraphIssueCode,
} from "../src/lib/automation-graph";
import { automationEnrollments } from "../src/db/schema";
import { newId, nowIso } from "../src/lib/ids";
import { testDb } from "./helpers";

// Node keys are `nd_…` (the stable identity that survives edits and version
// bumps), so the fixtures use readable ones rather than random ids.
const K = {
  trigger: "nd_trigger",
  welcome: "nd_welcome",
  wait: "nd_wait",
  branch: "nd_branch",
  upgrade: "nd_upgrade",
  end: "nd_end",
};

function node(
  key: string,
  kind: AutomationGraphNode["kind"],
  config: unknown = {},
  label?: string,
): AutomationGraphNode {
  return { key, kind, config, ...(label ? { label } : {}) };
}

function sendConfig(overrides: Record<string, unknown> = {}) {
  return {
    subject: "Welcome to Day3",
    htmlBody: "<p>Hello there</p>",
    ...overrides,
  };
}

function edge(fromKey: string, port: AutomationGraphEdge["port"], toKey: string) {
  return { fromKey, port, toKey };
}

// trigger → welcome email → wait 3 days → end
function linearGraph(): AutomationGraph {
  return {
    nodes: [
      node(K.trigger, "trigger"),
      node(K.welcome, "send", sendConfig(), "Welcome email"),
      node(K.wait, "wait", { value: 3, unit: "days", clampToSendWindow: false }),
      node(K.end, "end"),
    ],
    edges: [
      edge(K.trigger, "next", K.welcome),
      edge(K.welcome, "next", K.wait),
      edge(K.wait, "next", K.end),
    ],
  };
}

function codes(issues: { code: GraphIssueCode }[]): GraphIssueCode[] {
  return issues.map((i) => i.code);
}

describe("automation graph validation", () => {
  it("accepts a well-formed linear flow", () => {
    const result = validateGraph(linearGraph());
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("requires exactly one trigger", () => {
    const none = validateGraph({ nodes: [node(K.end, "end")], edges: [] });
    expect(codes(none.errors)).toContain("no_trigger");

    const graph = linearGraph();
    graph.nodes.push(node("nd_second", "trigger"));
    expect(codes(validateGraph(graph).errors)).toContain("multiple_triggers");
  });

  it("blocks a send node with no subject or no content", () => {
    const noSubject = linearGraph();
    noSubject.nodes[1] = node(K.welcome, "send", sendConfig({ subject: "  " }));
    expect(codes(validateGraph(noSubject).errors)).toContain("send_missing_content");

    const noBody = linearGraph();
    noBody.nodes[1] = node(K.welcome, "send", sendConfig({ htmlBody: "" }));
    expect(codes(validateGraph(noBody).errors)).toContain("send_missing_content");
  });

  it("reports a half-configured node instead of throwing", () => {
    const graph = linearGraph();
    graph.nodes[2] = node(K.wait, "wait", { value: 0, unit: "weeks" });
    const result = validateGraph(graph);
    expect(codes(result.errors)).toContain("invalid_config");
    expect(result.ok).toBe(false);
  });

  it("rejects a wait longer than a year", () => {
    const graph = linearGraph();
    graph.nodes[2] = node(K.wait, "wait", { value: 400, unit: "days" });
    expect(codes(validateGraph(graph).errors)).toContain("invalid_config");
  });

  it("rejects two edges out of one port, which would split the cursor", () => {
    const graph = linearGraph();
    graph.edges.push(edge(K.trigger, "next", K.end));
    expect(codes(validateGraph(graph).errors)).toContain("duplicate_port_edge");
  });

  it("rejects a port the node kind does not have", () => {
    const graph = linearGraph();
    graph.edges.push(edge(K.welcome, "yes", K.end));
    expect(codes(validateGraph(graph).errors)).toContain("invalid_port");
  });

  it("rejects an edge to a step that no longer exists", () => {
    const graph = linearGraph();
    graph.edges.push(edge(K.wait, "next", "nd_deleted"));
    expect(codes(validateGraph(graph).errors)).toContain("unknown_edge_node");
  });

  it("allows converging edges: two nodes pointing at one node is not a merge", () => {
    const graph: AutomationGraph = {
      nodes: [
        node(K.trigger, "trigger"),
        node(K.branch, "branch", {
          condition: { kind: "filter", filter: { match: "all", conditions: [{ field: "plan", op: "equals", value: "pro" }] } },
        }),
        node(K.welcome, "send", sendConfig()),
        node(K.upgrade, "send", sendConfig({ subject: "Upgrade" })),
        node(K.end, "end"),
      ],
      edges: [
        edge(K.trigger, "next", K.branch),
        edge(K.branch, "yes", K.welcome),
        edge(K.branch, "no", K.upgrade),
        edge(K.welcome, "next", K.end),
        edge(K.upgrade, "next", K.end),
      ],
    };
    const result = validateGraph(graph);
    expect(result.ok).toBe(true);
  });
});

describe("automation graph loop guards", () => {
  // trigger → wait → branch, whose "no" arm loops back to the wait.
  function loopGraph(wait: { value: number; unit: string }): AutomationGraph {
    return {
      nodes: [
        node(K.trigger, "trigger"),
        node(K.wait, "wait", { ...wait, clampToSendWindow: false }),
        node(K.branch, "branch", {
          condition: { kind: "engagement", event: "not_opened", nodeKey: null },
        }),
        node(K.end, "end"),
      ],
      edges: [
        edge(K.trigger, "next", K.wait),
        edge(K.wait, "next", K.branch),
        edge(K.branch, "yes", K.end),
        edge(K.branch, "no", K.wait),
      ],
    };
  }

  it("permits a loop that passes through a wait of an hour or more", () => {
    expect(validateGraph(loopGraph({ value: 30, unit: "days" })).ok).toBe(true);
    expect(validateGraph(loopGraph({ value: 1, unit: "hours" })).ok).toBe(true);
  });

  it("blocks a loop that can spin without time passing", () => {
    const result = validateGraph(loopGraph({ value: 30, unit: "minutes" }));
    expect(codes(result.errors)).toContain("cycle_without_wait");
  });

  it("blocks a loop with no wait node in it at all", () => {
    const graph: AutomationGraph = {
      nodes: [
        node(K.trigger, "trigger"),
        node(K.branch, "branch", {
          condition: { kind: "engagement", event: "opened", nodeKey: null },
        }),
        node(K.welcome, "send", sendConfig()),
        node(K.end, "end"),
      ],
      edges: [
        edge(K.trigger, "next", K.branch),
        edge(K.branch, "yes", K.end),
        edge(K.branch, "no", K.welcome),
        edge(K.welcome, "next", K.branch),
      ],
    };
    expect(codes(validateGraph(graph).errors)).toContain("cycle_without_wait");
  });

  it("rejects a node wired to itself", () => {
    const graph = linearGraph();
    graph.edges = [edge(K.trigger, "next", K.wait), edge(K.wait, "next", K.wait)];
    expect(codes(validateGraph(graph).errors)).toContain("self_edge");
  });

  it("finds strongly-connected components without enumerating cycles", () => {
    const components = stronglyConnectedComponents(loopGraph({ value: 1, unit: "days" }));
    const looping = components.find((c) => c.length > 1);
    expect(looping?.sort()).toEqual([K.branch, K.wait].sort());
  });
});

describe("automation graph warnings", () => {
  it("warns about a scratch node off to the side without blocking publish", () => {
    const graph = linearGraph();
    graph.nodes.push(node("nd_scratch", "send", sendConfig({ subject: "Draft idea" })));
    const result = validateGraph(graph);
    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toContain("unreachable_node");
  });

  it("warns that an unbound port ends the flow", () => {
    const graph = linearGraph();
    graph.edges = graph.edges.filter((e) => e.fromKey !== K.wait);
    const result = validateGraph(graph);
    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toContain("unbound_port");
  });

  it("warns about a branch whose answers go to the same step", () => {
    const graph: AutomationGraph = {
      nodes: [
        node(K.trigger, "trigger"),
        node(K.branch, "branch", {
          condition: { kind: "engagement", event: "clicked", nodeKey: null },
        }),
        node(K.end, "end"),
      ],
      edges: [
        edge(K.trigger, "next", K.branch),
        edge(K.branch, "yes", K.end),
        edge(K.branch, "no", K.end),
      ],
    };
    const result = validateGraph(graph);
    expect(result.ok).toBe(true);
    expect(codes(result.warnings)).toContain("branch_both_ports_same");
  });
});

describe("automation graph engagement predicates", () => {
  function withPredicate(nodeKey: string | null): AutomationGraph {
    return {
      nodes: [
        node(K.trigger, "trigger"),
        node(K.welcome, "send", sendConfig(), "Welcome email"),
        node(K.branch, "branch", {
          condition: { kind: "engagement", event: "clicked", nodeKey },
        }),
        node(K.end, "end"),
      ],
      edges: [
        edge(K.trigger, "next", K.welcome),
        edge(K.welcome, "next", K.branch),
        edge(K.branch, "yes", K.end),
        edge(K.branch, "no", K.end),
      ],
    };
  }

  it("accepts a predicate about a send node in the same automation", () => {
    expect(validateGraph(withPredicate(K.welcome)).ok).toBe(true);
  });

  it("accepts a predicate about any send node (null target)", () => {
    expect(validateGraph(withPredicate(null)).ok).toBe(true);
  });

  it("blocks a predicate about an email that was deleted", () => {
    const result = validateGraph(withPredicate("nd_deleted"));
    expect(codes(result.errors)).toContain("unknown_engagement_target");
  });

  it("blocks a predicate pointing at a node that is not a send", () => {
    const graph = withPredicate(K.end);
    expect(codes(validateGraph(graph).errors)).toContain("unknown_engagement_target");
  });
});

describe("automation graph ceilings", () => {
  it("blocks a canvas past the node ceiling", () => {
    const graph = linearGraph();
    for (let i = 0; i < MAX_AUTOMATION_NODES; i++) {
      graph.nodes.push(node(`nd_filler${i}`, "end"));
    }
    expect(codes(validateGraph(graph).errors)).toContain("too_many_nodes");
  });

  it("blocks two nodes sharing an id", () => {
    const graph = linearGraph();
    graph.nodes.push(node(K.welcome, "end"));
    expect(codes(validateGraph(graph).errors)).toContain("duplicate_node_key");
  });
});

describe("automation graph helpers", () => {
  it("routes a port to its single destination", () => {
    const graph = linearGraph();
    expect(nextNodeKey(graph, K.trigger, "next")).toBe(K.welcome);
    expect(nextNodeKey(graph, K.end, "next")).toBeNull();
  });

  it("converts wait durations to milliseconds", () => {
    expect(waitMillis({ value: 2, unit: "hours", clampToSendWindow: false })).toBe(7_200_000);
    expect(waitMillis({ value: 1, unit: "days", clampToSendWindow: false })).toBe(86_400_000);
  });

  it("renders the graph as a readable outline", () => {
    expect(graphOutline(linearGraph())).toBe(
      ["Trigger", "Welcome email", "Wait 3 days", "End"].join("\n"),
    );
  });

  it("indents branch arms and marks a loop back rather than recursing forever", () => {
    const graph: AutomationGraph = {
      nodes: [
        node(K.trigger, "trigger"),
        node(K.wait, "wait", { value: 1, unit: "days", clampToSendWindow: false }),
        node(K.branch, "branch", {
          condition: { kind: "engagement", event: "not_opened", nodeKey: null },
        }),
        node(K.upgrade, "send", sendConfig({ subject: "Still there?" })),
      ],
      edges: [
        edge(K.trigger, "next", K.wait),
        edge(K.wait, "next", K.branch),
        edge(K.branch, "yes", K.upgrade),
        edge(K.branch, "no", K.wait),
      ],
    };
    expect(graphOutline(graph)).toBe(
      [
        "Trigger",
        "Wait 1 day",
        "If",
        '  yes: Email "Still there?"',
        "  no: ↩ back to Wait 1 day",
      ].join("\n"),
    );
  });
});

// The re-entry rules are enforced by partial unique indexes rather than by a
// check-then-insert in application code, because the whole point is to survive
// a race (a CSV re-import and a form signup landing on the same subscriber at
// the same moment). A predicate that silently failed to apply would look fine
// in every unit test and duplicate welcome series in production, so these run
// against real Postgres.
describe("enrollment re-entry indexes", () => {
  async function enroll(
    db: Awaited<ReturnType<typeof testDb>>,
    input: {
      automationId: string;
      subscriberId: string;
      reentryMode: "once" | "once_at_a_time" | "always";
      status?: "active" | "completed";
    },
  ) {
    const now = nowIso();
    await db.insert(automationEnrollments).values({
      id: newId("aen"),
      accountId: "acc_test",
      automationId: input.automationId,
      automationVersionId: "aev_test",
      subscriberId: input.subscriberId,
      status: input.status ?? "active",
      reentryMode: input.reentryMode,
      enteredAt: now,
      createdAt: now,
      updatedAt: now,
    });
  }

  it("lets someone into a `once` automation exactly one time, ever", async () => {
    const db = await testDb();
    await enroll(db, { automationId: "aut_1", subscriberId: "sub_1", reentryMode: "once" });
    await expect(
      enroll(db, { automationId: "aut_1", subscriberId: "sub_1", reentryMode: "once" }),
    ).rejects.toThrow();

    // Completing does not free them up: `once` means once.
    await db.execute(sql`update automation_enrollments set status = 'completed'`);
    await expect(
      enroll(db, { automationId: "aut_1", subscriberId: "sub_1", reentryMode: "once" }),
    ).rejects.toThrow();
  });

  it("lets a `once_at_a_time` subscriber back in only after finishing", async () => {
    const db = await testDb();
    await enroll(db, {
      automationId: "aut_2",
      subscriberId: "sub_1",
      reentryMode: "once_at_a_time",
    });
    await expect(
      enroll(db, { automationId: "aut_2", subscriberId: "sub_1", reentryMode: "once_at_a_time" }),
    ).rejects.toThrow();

    await db.execute(sql`update automation_enrollments set status = 'completed'`);
    await enroll(db, {
      automationId: "aut_2",
      subscriberId: "sub_1",
      reentryMode: "once_at_a_time",
    });
    const rows = await db.select().from(automationEnrollments);
    expect(rows).toHaveLength(2);
  });

  it("allows concurrent runs on `always`, for recurring API events", async () => {
    const db = await testDb();
    await enroll(db, { automationId: "aut_3", subscriberId: "sub_1", reentryMode: "always" });
    await enroll(db, { automationId: "aut_3", subscriberId: "sub_1", reentryMode: "always" });
    const rows = await db.select().from(automationEnrollments);
    expect(rows).toHaveLength(2);
  });

  it("scopes re-entry per automation, not per subscriber", async () => {
    const db = await testDb();
    await enroll(db, { automationId: "aut_4", subscriberId: "sub_1", reentryMode: "once" });
    await enroll(db, { automationId: "aut_5", subscriberId: "sub_1", reentryMode: "once" });
    const rows = await db.select().from(automationEnrollments);
    expect(rows).toHaveLength(2);
  });
});
