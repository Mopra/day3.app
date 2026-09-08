"use client";

import "@xyflow/react/dist/style.css";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type Edge,
  type EdgeChange,
  type IsValidConnection,
  type NodeChange,
  type OnBeforeDelete,
} from "@xyflow/react";
import { AlignStartVertical, Check, CloudOff, FileText, Mail, Monitor } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { useIsMobile } from "@/hooks/use-mobile";
import {
  PORTS_BY_KIND,
  graphOutline,
  nodeTitle,
  validateGraph,
  type AutomationNodeKind,
  type GraphIssue,
  type GraphValidation,
  type NodePort,
  type SendNodeConfig,
} from "@/lib/automation-graph";
import type {
  AutomationDetail,
  AutomationStats,
  GraphPayload,
  GraphPayloadNode,
} from "@/lib/automation-types";
import { AddNodeButton, AddNodeContextMenu } from "./add-node-menu";
import { NodeInspector, type NodePatch } from "./inspector";
import { LAYER_GAP_Y, NODE_WIDTH, applyLayout, layoutGraph } from "./layout";
import { defaultConfig, mintNodeKey, needsLayout, nodeSummary, toDraftInput, toGraph } from "./node-kinds";
import { nodeTypes, type CanvasNode, type CanvasNodeData } from "./nodes";
import { SendNodeEditor } from "./send-node-editor";

// How long the graph must sit unchanged before the draft is saved. Matches the
// composer so the two "Saved" indicators on this page feel like one system.
const AUTOSAVE_DELAY_MS = 800;

export type SaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

export function SaveIndicator({ status }: { status: SaveStatus }) {
  if (status === "idle") return null;
  if (status === "error") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <CloudOff className="size-3.5" />
        Couldn&apos;t save. Your changes are still here.
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {status === "saved" ? (
        <>
          <Check className="size-3.5" />
          Saved
        </>
      ) : (
        <>
          <OrbitLoader size={14} />
          Saving
        </>
      )}
    </span>
  );
}

// React Flow's chrome (pane, edges, handles, controls) re-coloured with the app's
// own tokens. Custom nodes carry their own classes, so only the plumbing is here.
const FLOW_VARS = {
  "--xy-background-color-default": "var(--background)",
  "--xy-background-pattern-dots-color-default": "color-mix(in oklch, var(--foreground) 14%, transparent)",
  "--xy-edge-stroke-default": "var(--input)",
  "--xy-edge-stroke-selected-default": "var(--primary)",
  "--xy-edge-stroke-width-default": "1.5",
  "--xy-edge-label-background-color-default": "var(--card)",
  "--xy-edge-label-color-default": "var(--muted-foreground)",
  "--xy-connectionline-stroke-default": "var(--primary)",
  "--xy-connectionline-stroke-width-default": "1.5",
  "--xy-handle-background-color-default": "var(--input)",
  "--xy-handle-border-color-default": "var(--card)",
  "--xy-controls-button-background-color-default": "var(--card)",
  "--xy-controls-button-background-color-hover-default": "var(--muted)",
  "--xy-controls-button-color-default": "var(--muted-foreground)",
  "--xy-controls-button-color-hover-default": "var(--foreground)",
  "--xy-controls-button-border-color-default": "var(--border)",
  "--xy-controls-box-shadow-default": "none",
  "--xy-selection-background-color-default": "color-mix(in oklch, var(--primary) 8%, transparent)",
  "--xy-selection-border-default": "1px dashed var(--primary)",
  "--xy-attribution-background-color-default": "transparent",
} as CSSProperties;

// Module-level so React Flow sees one identity per option object across renders;
// a fresh literal each render would make it re-run its setup on every keystroke.
const FIT_VIEW_OPTIONS = { padding: 0.25, maxZoom: 1 } as const;
const DEFAULT_EDGE_OPTIONS = { type: "smoothstep" } as const;

type Props = {
  detail: AutomationDetail;
  stats: AutomationStats | null;
  onDetailChange: (detail: AutomationDetail) => void;
  onSaveStatus: (status: SaveStatus) => void;
  onOpenSettings: () => void;
  // Set after a failed publish: the canvas selects and scrolls to this node.
  focusNodeKey: string | null;
  // Set when the server's publish validation should replace the local one.
  serverValidation: GraphValidation | null;
  readOnly: boolean;
};

export function AutomationCanvas(props: Props) {
  const isMobile = useIsMobile();
  if (isMobile) return <MobileFallback detail={props.detail} />;
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}

// A phone gets the flow as prose instead of a canvas that cannot be edited with
// a thumb. People, Stats and Settings stay fully usable next to it.
function MobileFallback({ detail }: { detail: AutomationDetail }) {
  return (
    <Card>
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3">
          <Monitor className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <p className="font-medium">The canvas works best on a larger screen.</p>
            <p className="text-sm text-muted-foreground">
              Open this automation on a laptop to edit the steps. Here is the flow as it
              stands.
            </p>
          </div>
        </div>
        <pre className="overflow-x-auto rounded-lg bg-muted/40 p-3 font-mono text-xs leading-5 whitespace-pre">
          {graphOutline(toGraph(detail.draft))}
        </pre>
      </CardContent>
    </Card>
  );
}

function CanvasInner({
  detail,
  stats,
  onDetailChange,
  onSaveStatus,
  onOpenSettings,
  focusNodeKey,
  serverValidation,
  readOnly,
}: Props) {
  const rf = useReactFlow<CanvasNode, Edge>();

  /* ───────────────────────────── graph state ───────────────────────────── */

  // The editable graph. Seeded from the draft once (and again only if the draft
  // version itself changes), never from every detail refresh: a save response
  // arriving mid-drag must not snap the node back.
  const seed = useCallback((draft: GraphPayload): GraphPayload => {
    if (!needsLayout(draft.nodes)) return draft;
    return { ...draft, nodes: applyLayout(draft.nodes, layoutGraph(draft.nodes, draft.edges)) };
  }, []);
  const [graph, setGraph] = useState<GraphPayload>(() => seed(detail.draft));
  // Mirrors `graph` for callbacks (autosave, add-node) that must read the latest
  // value without re-arming on every change. `commit` writes it synchronously
  // as well, so a save fired right after an edit never sees a stale graph.
  const graphRef = useRef(graph);
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);
  const seededVersion = useRef(detail.draftVersionId);
  useEffect(() => {
    if (seededVersion.current === detail.draftVersionId) return;
    seededVersion.current = detail.draftVersionId;
    setGraph(seed(detail.draft));
  }, [detail.draftVersionId, detail.draft, seed]);

  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [showOutline, setShowOutline] = useState(false);
  const [menu, setMenu] = useState<{ screen: { x: number; y: number }; flow: { x: number; y: number } } | null>(null);

  /* ────────────────────────────── autosave ─────────────────────────────── */

  const [saveStatus, setSaveStatusState] = useState<SaveStatus>("idle");
  const setSaveStatus = useCallback(
    (s: SaveStatus) => {
      setSaveStatusState(s);
      onSaveStatus(s);
    },
    [onSaveStatus],
  );
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const inFlight = useRef(false);
  const detailIdRef = useRef(detail.id);
  const onDetailChangeRef = useRef(onDetailChange);
  useEffect(() => {
    detailIdRef.current = detail.id;
    onDetailChangeRef.current = onDetailChange;
  }, [detail.id, onDetailChange]);

  // One PUT at a time. Two overlapping requests could be applied by the server
  // in either order, and the older graph would win; serialising them means the
  // request that goes out always carries the newest graph, and the response
  // that comes back is never stale. An edit made while a request is out marks
  // the graph dirty and is picked up the moment that request lands.
  const save = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      dirty.current = true;
      return;
    }
    inFlight.current = true;
    setSaveStatus("saving");
    try {
      // Loop until a request has gone out with nothing edited behind it.
      do {
        dirty.current = false;
        // The shared api helper has no PUT; same-origin fetch with the same
        // error convention (the body's `error` string, else the status text).
        const res = await fetch(`/api/automations/${detailIdRef.current}/draft`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(toDraftInput(graphRef.current)),
        });
        const body = (await res.json().catch(() => ({}))) as AutomationDetail & { error?: string };
        if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : res.statusText);
        onDetailChangeRef.current(body);
        // A later edit landed while the request was out: it goes now rather
        // than after another debounce, and the timer that edit armed is dropped
        // so the same graph is not sent twice.
        if (dirty.current && timer.current) {
          clearTimeout(timer.current);
          timer.current = null;
        }
      } while (dirty.current);
      setSaveStatus("saved");
    } catch (err) {
      dirty.current = true;
      setSaveStatus("error");
      toast.error(err instanceof Error ? err.message : "Couldn't save the draft");
    } finally {
      inFlight.current = false;
    }
  }, [setSaveStatus]);

  const scheduleSave = useCallback(() => {
    if (readOnly) return;
    dirty.current = true;
    setSaveStatus("pending");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
  }, [readOnly, save, setSaveStatus]);

  // Leaving the tab mid-edit must not drop the last change.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (dirty.current) void save();
    },
    [save],
  );

  // Every edit goes through here: update, then arm the save.
  const commit = useCallback(
    (updater: (g: GraphPayload) => GraphPayload) => {
      setGraph((g) => {
        const next = updater(g);
        graphRef.current = next;
        return next;
      });
      scheduleSave();
    },
    [scheduleSave],
  );

  // A graph laid out on load (all nodes at the origin) is worth persisting so
  // the next open does not shuffle it again.
  useEffect(() => {
    if (needsLayout(detail.draft.nodes) && !readOnly) scheduleSave();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ─────────────────────────────── derived ─────────────────────────────── */

  // The same validator the API runs, so the red dots never disagree with the
  // publish dialog. The server's verdict wins right after a failed publish (it
  // also covers what only the server knows, like the risk review).
  const validation = useMemo(
    () => serverValidation ?? validateGraph(toGraph(graph)),
    [graph, serverValidation],
  );
  const issuesByNode = useMemo(() => {
    const map = new Map<string, { errors: GraphIssue[]; warnings: GraphIssue[] }>();
    const bucket = (key: string) => {
      let b = map.get(key);
      if (!b) map.set(key, (b = { errors: [], warnings: [] }));
      return b;
    };
    for (const e of validation.errors) if (e.nodeKey) bucket(e.nodeKey).errors.push(e);
    for (const w of validation.warnings) if (w.nodeKey) bucket(w.nodeKey).warnings.push(w);
    return map;
  }, [validation]);

  const statsByKey = useMemo(
    () => new Map((stats?.nodes ?? []).map((s) => [s.nodeKey, s])),
    [stats],
  );

  const rfNodes = useMemo<CanvasNode[]>(
    () =>
      graph.nodes.map((n) => {
        const issues = issuesByNode.get(n.key);
        const data: CanvasNodeData = {
          node: n,
          title: nodeTitle(n),
          summary: nodeSummary(n, graph.nodes),
          stats: statsByKey.get(n.key) ?? null,
          error: issues?.errors[0]?.message ?? null,
          warning: issues?.warnings[0]?.message ?? null,
          readOnly,
        };
        return {
          id: n.key,
          type: n.kind,
          position: { x: n.x, y: n.y },
          data,
          selected: n.key === selectedKey,
          deletable: n.kind !== "trigger" && !readOnly,
          draggable: !readOnly,
          connectable: !readOnly,
        };
      }),
    [graph.nodes, issuesByNode, statsByKey, selectedKey, readOnly],
  );

  const rfEdges = useMemo<Edge[]>(() => {
    const kinds = new Map(graph.nodes.map((n) => [n.key, n.kind]));
    return graph.edges.map((e) => ({
      id: `${e.fromKey}:${e.port}`,
      source: e.fromKey,
      sourceHandle: e.port,
      target: e.toKey,
      type: "smoothstep",
      label: kinds.get(e.fromKey) === "branch" ? e.port : undefined,
      deletable: !readOnly,
      focusable: true,
    }));
  }, [graph.nodes, graph.edges, readOnly]);

  const selectedNode = selectedKey ? graph.nodes.find((n) => n.key === selectedKey) ?? null : null;
  const editingNode = editingKey ? graph.nodes.find((n) => n.key === editingKey) ?? null : null;
  const onlyTrigger = graph.nodes.length === 1 && graph.nodes[0]?.kind === "trigger";

  /* ────────────────────────────── mutations ────────────────────────────── */

  const removeNodes = useCallback(
    (keys: string[]) => {
      const drop = new Set(keys.filter((k) => graphRef.current.nodes.find((n) => n.key === k)?.kind !== "trigger"));
      if (drop.size === 0) return;
      commit((g) => ({
        nodes: g.nodes.filter((n) => !drop.has(n.key)),
        edges: g.edges.filter((e) => !drop.has(e.fromKey) && !drop.has(e.toKey)),
      }));
      setSelectedKey((k) => (k && drop.has(k) ? null : k));
    },
    [commit],
  );

  const patchNode = useCallback(
    (key: string, patch: NodePatch) => {
      commit((g) => ({
        ...g,
        nodes: g.nodes.map((n) =>
          n.key === key
            ? {
                ...n,
                ...("label" in patch ? { label: patch.label ?? null } : {}),
                ...("config" in patch ? { config: patch.config } : {}),
              }
            : n,
        ),
      }));
    },
    [commit],
  );

  const connect = useCallback(
    (fromKey: string, port: NodePort, toKey: string) => {
      if (fromKey === toKey) return;
      commit((g) => ({
        ...g,
        // One destination per port: a new connection replaces the old one.
        edges: [
          ...g.edges.filter((e) => !(e.fromKey === fromKey && e.port === port)),
          { fromKey, port, toKey },
        ],
      }));
    },
    [commit],
  );

  // Adds a node. Without a position it goes under the selected node (or the
  // bottom of the flow) and, when the selected node has a free `next` port,
  // gets wired to it: "select the last step, add the next one" is the common
  // gesture and should not need a drag.
  const addNode = useCallback(
    (kind: AutomationNodeKind, at?: { x: number; y: number }) => {
      const key = mintNodeKey();
      const g = graphRef.current;
      const anchor = selectedKey ? g.nodes.find((n) => n.key === selectedKey) ?? null : null;
      let position = at;
      if (!position) {
        if (anchor) {
          position = { x: anchor.x, y: anchor.y + LAYER_GAP_Y };
        } else {
          const bottom = g.nodes.reduce((m, n) => Math.max(m, n.y), 0);
          const trigger = g.nodes.find((n) => n.kind === "trigger");
          position = { x: trigger?.x ?? 0, y: g.nodes.length ? bottom + LAYER_GAP_Y : 0 };
        }
        // Nudge sideways off anything already occupying that spot.
        while (g.nodes.some((n) => Math.abs(n.x - position!.x) < 40 && Math.abs(n.y - position!.y) < 40)) {
          position = { x: position.x + NODE_WIDTH + 40, y: position.y };
        }
      }
      const node: GraphPayloadNode = {
        key,
        kind,
        config: defaultConfig(kind),
        label: null,
        x: Math.round(position.x),
        y: Math.round(position.y),
        risk: null,
      };
      const autoWire =
        !at &&
        anchor &&
        PORTS_BY_KIND[anchor.kind].includes("next") &&
        !g.edges.some((e) => e.fromKey === anchor.key && e.port === "next");
      commit((cur) => ({
        nodes: [...cur.nodes, node],
        edges: autoWire ? [...cur.edges, { fromKey: anchor.key, port: "next" as const, toKey: key }] : cur.edges,
      }));
      setSelectedKey(key);
      setMenu(null);
      if (kind === "send") setEditingKey(key);
    },
    [commit, selectedKey],
  );

  // The empty-canvas shortcut: a first email, wired to the trigger.
  const addFirstEmail = useCallback(() => {
    const trigger = graphRef.current.nodes.find((n) => n.kind === "trigger");
    if (!trigger) return;
    const key = mintNodeKey();
    const node: GraphPayloadNode = {
      key,
      kind: "send",
      config: defaultConfig("send"),
      label: null,
      x: trigger.x,
      y: trigger.y + LAYER_GAP_Y,
      risk: null,
    };
    commit((g) => ({
      nodes: [...g.nodes, node],
      edges: [...g.edges, { fromKey: trigger.key, port: "next", toKey: key }],
    }));
    setSelectedKey(key);
    setEditingKey(key);
  }, [commit]);

  const tidyUp = useCallback(() => {
    commit((g) => ({ ...g, nodes: applyLayout(g.nodes, layoutGraph(g.nodes, g.edges)) }));
    requestAnimationFrame(() => void rf.fitView({ padding: 0.2, duration: 300, maxZoom: 1 }));
  }, [commit, rf]);

  /* ───────────────────────── React Flow callbacks ──────────────────────── */

  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      const moved = new Map<string, { x: number; y: number }>();
      const removed: string[] = [];
      let select: string | null | undefined;
      for (const c of changes) {
        if (c.type === "position" && c.position) moved.set(c.id, c.position);
        else if (c.type === "remove") removed.push(c.id);
        else if (c.type === "select") {
          if (c.selected) select = c.id;
          else if (select === undefined) select = null;
        }
      }
      if (moved.size > 0) {
        commit((g) => ({
          ...g,
          nodes: g.nodes.map((n) => {
            const p = moved.get(n.key);
            return p ? { ...n, x: Math.round(p.x), y: Math.round(p.y) } : n;
          }),
        }));
      }
      if (removed.length > 0) removeNodes(removed);
      if (select !== undefined) {
        setSelectedKey((cur) => {
          if (select) return select;
          // A deselect only clears when it is about the node currently shown.
          const deselected = changes.some((c) => c.type === "select" && !c.selected && c.id === cur);
          return deselected ? null : cur;
        });
      }
    },
    [commit, removeNodes],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<Edge>[]) => {
      const removed = new Set(changes.filter((c) => c.type === "remove").map((c) => c.id));
      if (removed.size === 0) return;
      commit((g) => ({ ...g, edges: g.edges.filter((e) => !removed.has(`${e.fromKey}:${e.port}`)) }));
    },
    [commit],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (!c.source || !c.target) return;
      const port = (c.sourceHandle ?? "next") as NodePort;
      connect(c.source, port, c.target);
    },
    [connect],
  );

  const isValidConnection = useCallback<IsValidConnection<Edge>>(
    (c) => !!c.source && !!c.target && c.source !== c.target,
    [],
  );

  // The trigger is the one node the canvas will not let go of.
  const onBeforeDelete = useCallback<OnBeforeDelete<CanvasNode, Edge>>(
    async ({ nodes, edges }) => {
      const kept = nodes.filter((n) => n.type !== "trigger");
      if (kept.length === 0 && edges.length === 0) return false;
      return { nodes: kept, edges };
    },
    [],
  );

  const onPaneContextMenu = useCallback(
    (event: ReactMouseEvent | MouseEvent) => {
      event.preventDefault();
      if (readOnly) return;
      setMenu({
        screen: { x: event.clientX, y: event.clientY },
        flow: rf.screenToFlowPosition({ x: event.clientX, y: event.clientY }),
      });
    },
    [readOnly, rf],
  );

  // Escape closes the inspector, but only from the canvas itself: inside an
  // input or an open popup it means what it always means there.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape" || editingKey) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest("input, textarea, select, [role=dialog], [role=listbox], [role=menu]"))) return;
      setSelectedKey(null);
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [editingKey]);

  // After a failed publish: bring the first offending node into view.
  useEffect(() => {
    if (!focusNodeKey) return;
    setSelectedKey(focusNodeKey);
    void rf.fitView({ nodes: [{ id: focusNodeKey }], duration: 300, maxZoom: 1, padding: 0.5 });
  }, [focusNodeKey, rf]);

  /* ─────────────────────────────── render ──────────────────────────────── */

  return (
    <div className="flex h-[calc(100vh-15rem)] min-h-[540px] overflow-hidden rounded-xl bg-background ring-1 ring-foreground/10">
      <div className="relative min-w-0 flex-1" style={FLOW_VARS}>
        <ReactFlow<CanvasNode, Edge>
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          isValidConnection={isValidConnection}
          onBeforeDelete={onBeforeDelete}
          onPaneContextMenu={onPaneContextMenu}
          onPaneClick={() => setMenu(null)}
          onNodeDoubleClick={(_, n) => n.type === "send" && !readOnly && setEditingKey(n.id)}
          deleteKeyCode={readOnly || editingKey ? null : ["Delete", "Backspace"]}
          nodesConnectable={!readOnly}
          elementsSelectable
          fitView
          fitViewOptions={FIT_VIEW_OPTIONS}
          minZoom={0.3}
          maxZoom={1.5}
          defaultEdgeOptions={DEFAULT_EDGE_OPTIONS}
          className="!bg-transparent"
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1.2} />
          <Controls showInteractive={false} position="bottom-right" className="!m-3 !rounded-lg !overflow-hidden" />

          <Panel position="top-left" className="!m-3">
            <div className="flex items-center gap-2 rounded-xl bg-card/95 p-1.5 ring-1 ring-foreground/10 backdrop-blur">
              {!readOnly && <AddNodeButton onPick={(kind) => addNode(kind)} />}
              <Button variant="ghost" size="sm" onClick={tidyUp}>
                <AlignStartVertical />
                Tidy up
              </Button>
              <Button
                variant={showOutline ? "secondary" : "ghost"}
                size="sm"
                aria-pressed={showOutline}
                onClick={() => setShowOutline((v) => !v)}
              >
                <FileText />
                Summary
              </Button>
              <div className="pl-1 pr-1.5">
                <SaveIndicator status={saveStatus} />
              </div>
            </div>
          </Panel>

          {onlyTrigger && !readOnly && (
            <Panel position="top-center" className="!mt-20">
              <div className="w-72 rounded-xl bg-card p-4 text-sm ring-1 ring-foreground/10">
                <p className="font-display text-lg leading-snug">Add your first email.</p>
                <p className="mt-1 text-muted-foreground">
                  Everyone who enters through the trigger gets it. Waits and branches can come
                  after.
                </p>
                <Button size="sm" className="mt-3" onClick={addFirstEmail}>
                  <Mail />
                  Add an email
                </Button>
              </div>
            </Panel>
          )}

          {showOutline && (
            <Panel position="bottom-left" className="!m-3">
              <pre className="max-h-64 max-w-md overflow-auto rounded-xl bg-card/95 p-3 font-mono text-xs leading-5 whitespace-pre ring-1 ring-foreground/10 backdrop-blur">
                {graphOutline(toGraph(graph))}
              </pre>
            </Panel>
          )}
        </ReactFlow>

        <AddNodeContextMenu
          position={menu?.screen ?? null}
          onPick={(kind) => menu && addNode(kind, menu.flow)}
          onClose={() => setMenu(null)}
        />
      </div>

      {/* `nokey` is React Flow's opt-out class: a Delete or Backspace pressed
          anywhere in the inspector (a focused button, a select trigger) must
          edit the field it was aimed at, never remove the node behind it.
          Inputs are already exempt; the class covers everything else. */}
      {selectedNode && (
        <aside className="nokey w-[22rem] shrink-0 border-l border-border bg-card">
          <NodeInspector
            key={selectedNode.key}
            node={selectedNode}
            nodes={graph.nodes}
            detail={detail}
            issues={issuesByNode.get(selectedNode.key) ?? { errors: [], warnings: [] }}
            readOnly={readOnly}
            onChange={(patch) => patchNode(selectedNode.key, patch)}
            onDelete={() => removeNodes([selectedNode.key])}
            onEditEmail={() => setEditingKey(selectedNode.key)}
            onOpenSettings={onOpenSettings}
            onClose={() => setSelectedKey(null)}
          />
        </aside>
      )}

      {editingNode && editingNode.kind === "send" && (
        <SendNodeEditor
          node={editingNode}
          detail={detail}
          onSaveConfig={(config: SendNodeConfig) => patchNode(editingNode.key, { config })}
          onDetailChange={onDetailChange}
          onClose={() => setEditingKey(null)}
        />
      )}
    </div>
  );
}
