"use client";

// "Send test" action for a campaign: a button that opens a small dialog where
// the user picks who receives the test — pre-filled with their own email, with
// room for a few more (a colleague, a personal inbox to check rendering, …).
// Shared by the campaign detail page and the new-campaign action cluster.
import { useState } from "react";
import { useUser } from "@clerk/nextjs";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { SendDots } from "@/components/ui/send-loader";
import { useApi } from "@/lib/api";

// Mirrors the cap in /api/campaigns/[id]/test-email.
const MAX_TEST_RECIPIENTS = 5;

// Light client-side check — the API (zod) is the real validator.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function SendTestButton({
  campaignId,
  disabled,
}: {
  campaignId: string;
  disabled?: boolean;
}) {
  const api = useApi();
  const { user } = useUser();

  const [open, setOpen] = useState(false);
  const [emails, setEmails] = useState<string[]>([""]);
  const [sending, setSending] = useState(false);

  function openDialog() {
    // Seed with the user's own address every time — the common case is still
    // "send it to me", and a stale list from a previous campaign would surprise.
    setEmails([user?.primaryEmailAddress?.emailAddress ?? ""]);
    setOpen(true);
  }

  function setEmail(index: number, value: string) {
    setEmails((cur) => cur.map((e, i) => (i === index ? value : e)));
  }

  // Blank rows are ignored rather than blocking the send.
  const recipients = [
    ...new Set(emails.map((e) => e.trim().toLowerCase()).filter(Boolean)),
  ];
  const allValid =
    recipients.length > 0 && recipients.every((e) => EMAIL_RE.test(e));

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!allValid || sending) return;
    setSending(true);
    try {
      const res = await api.post<{
        sent: string[];
        failed: { email: string; error: string }[];
      }>(`/api/campaigns/${campaignId}/test-email`, { toEmails: recipients });
      if (res.sent.length > 0) {
        toast.success(
          res.sent.length === 1
            ? `Test sent to ${res.sent[0]}`
            : `Test sent to ${res.sent.length} recipients`,
        );
      }
      for (const f of res.failed) {
        toast.error(`Couldn't send to ${f.email}: ${f.error}`);
      }
      // Keep the dialog open on a partial failure so the user can retry.
      if (res.failed.length === 0) setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send test");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Button variant="outline" disabled={disabled || sending} onClick={openDialog}>
        Send test
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Send a test email</DialogTitle>
          </DialogHeader>
          <form onSubmit={send} className="space-y-4">
            <p className="text-sm text-muted-foreground">
              We&apos;ll send a preview of this campaign with{" "}
              <span className="font-medium text-foreground">[Test]</span> in the
              subject line — to up to {MAX_TEST_RECIPIENTS} addresses.
            </p>
            <div className="space-y-2">
              {emails.map((email, i) => {
                const trimmed = email.trim();
                return (
                  <div key={i} className="flex items-center gap-2">
                    <Input
                      type="email"
                      value={email}
                      placeholder="name@example.com"
                      aria-label={`Recipient ${i + 1}`}
                      aria-invalid={trimmed !== "" && !EMAIL_RE.test(trimmed.toLowerCase())}
                      onChange={(e) => setEmail(i, e.target.value)}
                    />
                    {emails.length > 1 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove recipient ${i + 1}`}
                        disabled={sending}
                        onClick={() =>
                          setEmails((cur) => cur.filter((_, idx) => idx !== i))
                        }
                      >
                        <X />
                      </Button>
                    )}
                  </div>
                );
              })}
              {emails.length < MAX_TEST_RECIPIENTS && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  disabled={sending}
                  onClick={() => setEmails((cur) => [...cur, ""])}
                >
                  <Plus />
                  Add recipient
                </Button>
              )}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button
                type="button"
                variant="ghost"
                disabled={sending}
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={sending || !allValid}>
                {sending ? (
                  <>
                    <SendDots />
                    Sending…
                  </>
                ) : recipients.length > 1 ? (
                  `Send test to ${recipients.length}`
                ) : (
                  "Send test"
                )}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
