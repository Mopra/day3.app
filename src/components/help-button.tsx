"use client";

import { useState } from "react";
import { LifeBuoyIcon, Loader2Icon, CheckIcon } from "lucide-react";
import { useApi, ApiError } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover";

const CONTACT_EMAIL = "contact@day3.app";

// Bottom-of-sidebar Help widget. Opens a popover with a single message box that
// relays to the support inbox (POST /api/support); falls back to a plain mailto
// link. There's no docs site yet, so this is the whole help surface.
export function HelpButton() {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
        className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground"
      >
        <LifeBuoyIcon className="size-4 shrink-0" />
        Help
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-80">
        {sent ? (
          <div className="flex flex-col items-center gap-2 py-4 text-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground">
              <CheckIcon className="size-5" />
            </span>
            <p className="font-medium">Message sent</p>
            <p className="text-xs text-muted-foreground">
              Thanks — we read every message and will get back to you by email.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div>
              <p className="font-medium">Need help?</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Describe what you need help with — we read every message.
              </p>
            </div>
            <Textarea
              autoFocus
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="What can we help with?"
              rows={4}
              className="min-h-24 resize-none text-sm"
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
        )}
      </PopoverContent>
    </Popover>
  );
}
