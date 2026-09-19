"use client";

import { useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { Loader2Icon, CheckIcon } from "lucide-react";
import { LifeBuoyIcon, type LifeBuoyIconHandle } from "@/components/ui/animated-icons/life-buoy";
import { useApi, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";
import { helpLinksForPath } from "@/lib/docs-links";
import { DocsLinkRow } from "@/components/docs-link";

const CONTACT_EMAIL = "connect@day3.app";

// Bottom-of-sidebar Help widget. Two things behind one row: the written help
// for the page you are actually on, and a message box that relays to the
// support inbox (POST /api/support), with a plain mailto link as the fallback.
//
// The reading comes first because it usually answers the question without
// costing anyone a reply. It is route-scoped rather than a single link to
// docs.day3.app on purpose: that site is the *API reference*, so a flat
// "Documentation" link drops a non-technical user on `POST /v1/emails` when
// what they wanted was the DNS explainer. `helpLinksForPath` owns that choice
// for every surface — see src/lib/docs-links.ts.
export function HelpButton() {
  const api = useApi();
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Same hover contract the sidebar nav items use: the row drives the glyph.
  const iconRef = useRef<LifeBuoyIconHandle>(null);

  const links = helpLinksForPath(pathname ?? "");

  // Reset everything whenever the popover closes so a reopen starts fresh.
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setMessage("");
      setSending(false);
      setSent(false);
      setError(null);
    }
  }

  async function handleSend() {
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.post("/api/support", { message: trimmed });
      setSent(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't send your message. Please try again.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <PopoverTrigger
        onMouseEnter={() => iconRef.current?.startAnimation()}
        onMouseLeave={() => iconRef.current?.stopAnimation()}
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
      >
        <LifeBuoyIcon ref={iconRef} size={16} className="inline-flex shrink-0" />
        Help &amp; docs
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-[22rem] p-0">
        {sent ? (
          <div className="flex flex-col items-center gap-2 p-4 py-6 text-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground">
              <CheckIcon className="size-5" />
            </span>
            <p className="font-medium">Message sent</p>
            <p className="text-xs text-muted-foreground">
              Thanks — we read every message and will get back to you by email.
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {/* ── Reading for this page ──────────────────────────────── */}
            <div className="flex flex-col gap-1 p-2">
              <p className="px-2 pt-1 pb-0.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
                For this page
              </p>
              {links.map((link) => (
                <DocsLinkRow key={link.href} link={link} />
              ))}
            </div>

            {/* ── Ask a person ───────────────────────────────────────── */}
            <div className="flex flex-col gap-3 border-t border-border p-4">
              <div>
                <p className="text-sm font-medium">Still stuck?</p>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  Tell us what you were trying to do — we read every message.
                </p>
              </div>
              <Textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                    e.preventDefault();
                    void handleSend();
                  }
                }}
                placeholder="What can we help with?"
                rows={3}
                className="min-h-20 resize-none text-sm"
              />
              {error && <p className="text-xs text-destructive">{error}</p>}
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs text-muted-foreground">
                  Or email{" "}
                  <a
                    href={`mailto:${CONTACT_EMAIL}`}
                    className="text-foreground underline underline-offset-2 hover:text-primary"
                  >
                    {CONTACT_EMAIL}
                  </a>
                </span>
                <Button
                  size="sm"
                  onClick={handleSend}
                  disabled={!message.trim() || sending}
                >
                  {sending && <Loader2Icon className="size-3.5 animate-spin" />}
                  Send
                </Button>
              </div>
            </div>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
