"use client";

import { Switch as SwitchPrimitive } from "@base-ui/react/switch";

import { cn } from "@/lib/utils";

// An on/off control for settings rows, where the label sits to the left and the
// state must be readable at a glance from across the row. Checkboxes elsewhere
// in the app answer "which of these?"; a switch answers "is this on?", and it is
// the one control that reads the same whether or not you can see its label.
//
// Base UI renders a <button role="switch">, so a surrounding `fieldset disabled`
// already blocks interaction; pass `disabled` as well when the dimmed styling
// should follow.
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5 transition-colors outline-none",
        "focus-visible:ring-3 focus-visible:ring-ring/50",
        "data-checked:bg-primary data-unchecked:bg-input dark:data-unchecked:bg-input/70",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none size-4 rounded-full bg-background shadow-sm transition-transform",
          "data-checked:translate-x-4 data-unchecked:translate-x-0",
          "dark:data-checked:bg-primary-foreground dark:data-unchecked:bg-foreground/70",
        )}
      />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
