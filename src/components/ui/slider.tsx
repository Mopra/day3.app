"use client"

import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

// A single-thumb range slider on top of Base UI. The track fills its container,
// the indicator fills up to the value, and the thumb centers on the track. Pass
// `value` / `onValueChange` / `min` / `max` / `step` straight through.
function Slider<Value extends number | readonly number[]>({
  className,
  ...props
}: SliderPrimitive.Root.Props<Value>) {
  return (
    <SliderPrimitive.Root
      data-slot="slider"
      className={cn("relative w-full", className)}
      {...props}
    >
      <SliderPrimitive.Control className="flex w-full touch-none items-center py-3 select-none">
        <SliderPrimitive.Track className="relative h-2 w-full rounded-full bg-muted">
          {/* Glide the fill and thumb when the value is driven by scroll-sync; the
              short ease also smooths the discrete step-to-step jumps while dragging. */}
          <SliderPrimitive.Indicator className="rounded-full bg-primary transition-[width] duration-300 ease-out" />
          <SliderPrimitive.Thumb className="size-5 rounded-full border-2 border-primary bg-background shadow-sm outline-none transition-[inset-inline-start,scale,box-shadow] duration-300 ease-out focus-visible:ring-3 focus-visible:ring-ring/50 data-dragging:scale-110" />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
