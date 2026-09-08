import { PORTS_BY_KIND, type NodePort } from "@/lib/automation-graph";
import type { GraphPayloadEdge, GraphPayloadNode } from "@/lib/automation-types";

// A simple top-down auto layout. Layers are BFS depth from the trigger, so a
// linear flow reads straight down the middle and a branch fans its two arms out
// to either side; nodes not reachable from the trigger are parked in rows
// underneath so they stay visible instead of piling onto the origin.
//
// This is not a crossing-minimising layout and does not try to be: a canvas of
// at most 100 nodes drawn by one person is tidy enough with a BFS, and the
// coordinates are only ever a starting point the user is free to drag around.

// Matches the custom node component's fixed width plus breathing room, and a
// row height that clears the tallest node (title, summary, two badge rows).
export const NODE_WIDTH = 260;
export const LAYER_GAP_Y = 170;
export const SIBLING_GAP_X = NODE_WIDTH + 60;

export type Position = { x: number; y: number };

const PORT_ORDER: NodePort[] = ["yes", "next", "no"];

export function layoutGraph(
  nodes: GraphPayloadNode[],
  edges: GraphPayloadEdge[],
): Map<string, Position> {
  const positions = new Map<string, Position>();
  if (nodes.length === 0) return positions;

  const byKey = new Map(nodes.map((n) => [n.key, n]));
  const trigger = nodes.find((n) => n.kind === "trigger") ?? nodes[0];

  // Children of a node in port order (yes on the left, no on the right), which is
  // what keeps a branch's two arms from swapping sides between tidy-ups.
  const children = (key: string): string[] => {
    const node = byKey.get(key);
    if (!node) return [];
    const ports = PORTS_BY_KIND[node.kind] ?? [];
    const out: string[] = [];
    for (const port of PORT_ORDER) {
      if (!ports.includes(port)) continue;
      const edge = edges.find((e) => e.fromKey === key && e.port === port);
      if (edge && byKey.has(edge.toKey)) out.push(edge.toKey);
    }
    return out;
  };

  // BFS depth from the trigger. A node reached along two paths sits at the
  // shallowest depth, so a converging branch rejoins the main column.
  const depth = new Map<string, number>([[trigger.key, 0]]);
  const order: string[] = [trigger.key];
  for (let i = 0; i < order.length; i++) {
    const key = order[i];
    for (const next of children(key)) {
      if (depth.has(next)) continue;
      depth.set(next, depth.get(key)! + 1);
      order.push(next);
    }
  }

  // Assign each reachable node a column within its layer. Children keep the
  // relative order of their parents (a plain layered sweep), which is enough to
  // stop arms of neighbouring branches from crossing in the common cases.
  const layers: string[][] = [];
  for (const key of order) {
    const d = depth.get(key)!;
    (layers[d] ??= []).push(key);
  }

  const widest = Math.max(...layers.map((l) => l.length));
  const totalWidth = (widest - 1) * SIBLING_GAP_X;
  layers.forEach((layer, d) => {
    const layerWidth = (layer.length - 1) * SIBLING_GAP_X;
    const offset = (totalWidth - layerWidth) / 2;
    layer.forEach((key, i) => {
      positions.set(key, { x: Math.round(offset + i * SIBLING_GAP_X), y: d * LAYER_GAP_Y });
    });
  });

  // Anything the trigger cannot reach goes in rows below the flow, in the order
  // it appears in the draft, so scratch nodes stay findable.
  const orphans = nodes.filter((n) => !depth.has(n.key));
  const perRow = Math.max(widest, 3);
  const baseY = layers.length * LAYER_GAP_Y + LAYER_GAP_Y / 2;
  orphans.forEach((n, i) => {
    positions.set(n.key, {
      x: (i % perRow) * SIBLING_GAP_X,
      y: baseY + Math.floor(i / perRow) * LAYER_GAP_Y,
    });
  });

  return positions;
}

// Applies a layout to a node list, leaving everything but coordinates untouched.
export function applyLayout<T extends GraphPayloadNode>(
  nodes: T[],
  positions: Map<string, Position>,
): T[] {
  return nodes.map((n) => {
    const p = positions.get(n.key);
    return p ? { ...n, x: p.x, y: p.y } : n;
  });
}
