"use client";

import { memo } from "react";
import { Handle, Position, type Node, type NodeProps, type NodeTypes } from "@xyflow/react";
import { AlertTriangle } from "lucide-react";
import type { AutomationNodeKind } from "@/lib/automation-graph";
import type { GraphPayloadNode, NodeStats } from "@/lib/automation-types";
import { cn } from "@/lib/utils";
import { KIND_META } from "./node-kinds";
import { NODE_WIDTH } from "./layout";

// What the canvas hands each node component. Everything derived (title,
// summary, validation) is computed once per graph change in canvas.tsx rather
// than per node render, so a node re-renders only when its own data changes.
export type CanvasNodeData = {
  node: GraphPayloadNode;
  title: string;
  summary: string;
  stats: NodeStats | null;
  // The first validation error about this node, shown as the red dot's tooltip.
  error: string | null;
  warning: string | null;
  readOnly: boolean;
  [key: string]: unknown;
};

export type CanvasNode = Node<CanvasNodeData, AutomationNodeKind>;

const HANDLE_CLASS =
  "!size-3 !rounded-full !border-2 !border-card !bg-input transition-colors hover:!bg-primary";

function percent(part: number, whole: number): string {
  if (whole <= 0) return "0%";
  return `${Math.round((part / whole) * 100)}%`;
}

// Live numbers as short phrases. Only the ones that are non-zero are shown, so
// a fresh automation's nodes are quiet rather than a wall of zeros.
function StatBadges({ kind, stats }: { kind: AutomationNodeKind; stats: NodeStats }) {
  const items: { key: string; text: string; tone?: string }[] = [];
  if (stats.waiting > 0) {
    items.push({
      key: "waiting",
      text: `${stats.waiting.toLocaleString()} waiting here`,
      tone: "text-caramel",
    });
  }
  if (kind === "send" && stats.sent > 0) {
    items.push({
      key: "sent",
      text: `${stats.sent.toLocaleString()} sent, ${percent(stats.opened, stats.sent)} opened`,
    });
  }
  if (kind === "send" && stats.skipped > 0) {
    items.push({ key: "skipped", text: `${stats.skipped.toLocaleString()} skipped` });
  }
  if (items.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1.5 px-3 pb-3">
      {items.map((i) => (
        <span
          key={i.key}
          className={cn(
            "inline-flex h-5 items-center rounded-4xl bg-muted px-2 text-[11px] font-medium tabular-nums text-muted-foreground",
            i.tone,
          )}
        >
          {i.text}
        </span>
      ))}
    </div>
  );
}

function StepNodeComponent({ data, selected }: NodeProps<CanvasNode>) {
  const { node, title, summary, stats, error, warning, readOnly } = data;
  const meta = KIND_META[node.kind];
  const Icon = meta.icon;
  const isBranch = node.kind === "branch";
  const hasSource = node.kind !== "end";
  const connectable = !readOnly;

  return (
    <div
      className={cn(
        "group/node relative rounded-xl bg-card text-card-foreground shadow-[0_8px_24px_-18px_rgba(0,0,0,0.6)] ring-1 ring-foreground/10 transition-shadow",
        selected && "ring-2 ring-primary/70",
        error && !selected && "ring-destructive/50",
      )}
      style={{ width: NODE_WIDTH }}
    >
      {node.kind !== "trigger" && (
        <Handle
          type="target"
          position={Position.Top}
          isConnectable={connectable}
          className={HANDLE_CLASS}
        />
      )}

      {/* Header: icon, kind, title. items-center so a one-line title sits on the
          icon's axis; the summary hangs below on its own line. */}
      <div className="flex items-center gap-3 px-3 pt-3 pb-2">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted",
            meta.tone,
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {meta.label}
          </div>
          <div className="truncate text-sm font-medium leading-5" title={title}>
            {title}
          </div>
        </div>
      </div>

      {summary && (
        <p className="truncate px-3 pb-3 text-xs text-muted-foreground" title={summary}>
          {summary}
        </p>
      )}

      {stats && <StatBadges kind={node.kind} stats={stats} />}

      {/* The one place validation shows on the canvas itself: a red dot for an
          error (publish is blocked), the full text on hover and in the
          inspector. Warnings stay in the inspector; a dot for "this port ends
          the flow" on every last node would be noise. */}
      {error && (
        <span
          className="absolute -top-1 -right-1 flex size-4 items-center justify-center rounded-full bg-destructive text-destructive-foreground"
          title={error}
          aria-label={error}
        >
          <AlertTriangle className="size-2.5" />
        </span>
      )}
      {!error && warning && <span className="sr-only">{warning}</span>}

      {hasSource &&
        (isBranch ? (
          <>
            {/* Port labels sit exactly above their handles (30% / 70%). */}
            <div className="relative h-5 border-t border-border text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
              <span className="absolute left-[30%] top-0.5 -translate-x-1/2">yes</span>
              <span className="absolute left-[70%] top-0.5 -translate-x-1/2">no</span>
            </div>
            <Handle
              id="yes"
              type="source"
              position={Position.Bottom}
              isConnectable={connectable}
              style={{ left: "30%" }}
              className={HANDLE_CLASS}
            />
            <Handle
              id="no"
              type="source"
              position={Position.Bottom}
              isConnectable={connectable}
              style={{ left: "70%" }}
              className={HANDLE_CLASS}
            />
          </>
        ) : (
          <Handle
            id="next"
            type="source"
            position={Position.Bottom}
            isConnectable={connectable}
            className={HANDLE_CLASS}
          />
        ))}
    </div>
  );
}

const StepNode = memo(StepNodeComponent);

// One component for every kind: the kind decides ports and icon, not the
// component. Registered under each kind so React Flow's `type` stays the kind.
export const nodeTypes: NodeTypes = {
  trigger: StepNode,
  send: StepNode,
  wait: StepNode,
  branch: StepNode,
  end: StepNode,
};
