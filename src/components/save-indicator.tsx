"use client";

import { Check, CloudOff } from "lucide-react";
import { OrbitLoader } from "@/components/ui/orbit-loader";

// The "this saves itself" line every autosaving surface on the automation page
// shows: the canvas, the node inspector and the Settings tab. With no Save
// button, this is the only thing that tells the user their work is safe, so the
// three of them must say it the same way — it lives here rather than in the
// canvas so the Settings tab can show it without importing React Flow.
//
// "pending" (waiting out the debounce) and "saving" both read as "Saving" so a
// continuous edit doesn't flicker between two words.
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
