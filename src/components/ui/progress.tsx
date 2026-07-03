import * as React from "react"

import { cn } from "@/lib/utils"

function Progress({
  className,
  value = 0,
  indeterminate = false,
  ...props
}: React.ComponentProps<"div"> & { value?: number; indeterminate?: boolean }) {
  const clamped = Math.min(100, Math.max(0, value))
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={indeterminate ? undefined : clamped}
      className={cn("bg-primary/20 relative h-2 w-full overflow-hidden rounded-full", className)}
      {...props}
    >
      {indeterminate ? (
        // A looping sweep for work whose total isn't known yet — honest about
        // "we're working" without faking a percentage. Respects reduced-motion
        // (the animation utility is gated in globals.css).
        <div
          data-slot="progress-indicator"
          className="bg-primary absolute inset-y-0 w-1/3 animate-progress-indeterminate rounded-full"
        />
      ) : (
        <div
          data-slot="progress-indicator"
          className="bg-primary h-full w-full flex-1 transition-all"
          style={{ transform: `translateX(-${100 - clamped}%)` }}
        />
      )}
    </div>
  )
}

export { Progress }
