"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // fall through to the legacy path (e.g. non-secure dev origins)
  }
  try {
    const el = document.createElement("textarea");
    el.value = text;
    el.style.position = "fixed";
    el.style.opacity = "0";
    document.body.appendChild(el);
    el.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(el);
    return ok;
  } catch {
    return false;
  }
}

type CopyButtonProps = {
  value: string;
  /** Optional visible text shown next to the icon. */
  label?: string;
  /** Accessible label when there is no visible text. */
  title?: string;
  className?: string;
  variant?: "ghost" | "outline" | "secondary";
};

export function CopyButton({
  value,
  label,
  title,
  className,
  variant = "ghost",
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  const onCopy = useCallback(async () => {
    const ok = await copyText(value);
    if (!ok) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }, [value]);

  return (
    <Button
      type="button"
      variant={variant}
      size={label ? "xs" : "icon-xs"}
      onClick={onCopy}
      title={title ?? (label ? undefined : "Copy")}
      aria-label={title ?? (label ? `Copy ${label}` : "Copy")}
      className={cn(copied && "text-primary", className)}
    >
      {copied ? <Check /> : <Copy />}
      {label ? <span>{copied ? "Copied" : label}</span> : null}
    </Button>
  );
}
