"use client";

import { useEffect, useRef } from "react";
import { Plus } from "lucide-react";
import type { AutomationNodeKind } from "@/lib/automation-graph";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { ADDABLE_KINDS, KIND_META } from "./node-kinds";

// The kinds a user can add, as a vertical list of icon + name + one-liner. Shared
// by the toolbar popover and the right-click menu so the two never drift.
export function AddNodeMenuItems({
  onPick,
  className,
}: {
  onPick: (kind: AutomationNodeKind) => void;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      {ADDABLE_KINDS.map((kind) => {
        const meta = KIND_META[kind];
        const Icon = meta.icon;
        return (
          <button
            key={kind}
            type="button"
            onClick={() => onPick(kind)}
            className="flex items-center gap-3 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
          >
            <span
              className={cn(
                "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted",
                meta.tone,
              )}
            >
              <Icon className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="block text-sm font-medium leading-5">{meta.label}</span>
              <span className="block truncate text-xs text-muted-foreground">{meta.blurb}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

// The toolbar's "Add step" button with the kinds in a popover.
export function AddNodeButton({
  onPick,
  disabled,
}: {
  onPick: (kind: AutomationNodeKind) => void;
  disabled?: boolean;
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="sm" disabled={disabled}>
            <Plus />
            Add step
          </Button>
        }
      />
      <PopoverContent side="bottom" align="start" className="w-64 p-1.5">
        <AddNodeMenuItems onPick={onPick} />
      </PopoverContent>
    </Popover>
  );
}

// Right-click on empty canvas: the same list, anchored at the pointer. Closes on
// outside click or Escape; the parent decides where the new node lands (it knows
// the flow coordinates of the click).
export function AddNodeContextMenu({
  position,
  onPick,
  onClose,
}: {
  position: { x: number; y: number } | null;
  onPick: (kind: AutomationNodeKind) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!position) return;
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [position, onClose]);

  if (!position) return null;
  // Keep the menu on screen when the click lands near the right or bottom edge.
  const width = 256;
  const height = 4 * 44 + 12;
  const left = Math.min(position.x, window.innerWidth - width - 8);
  const top = Math.min(position.y, window.innerHeight - height - 8);
  return (
    <div
      ref={ref}
      role="menu"
      className="fixed z-50 rounded-xl bg-popover p-1.5 text-popover-foreground shadow-lg ring-1 ring-foreground/10"
      style={{ left, top, width }}
    >
      <AddNodeMenuItems onPick={onPick} />
    </div>
  );
}
