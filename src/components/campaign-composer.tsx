"use client";

// The campaign authoring experience. Replaces the old raw-HTML <CampaignForm>.
// Goals: make creating an email feel near-automatic for non-technical users.
//   - Opens straight onto a ready-to-write canvas; AI is opt-in via a prominent
//     (quietly animated) "Draft with AI" button, never a forced up-front choice.
//   - AI helpers: draft from a brief, subject ideas, auto preview text, and
//     select-to-rewrite (wired into the editor's bubble menu).
//   - A true WYSIWYG editor whose output is exactly what gets sent.
//   - Smart defaults: a sole audience auto-selects, and the From row is a dropdown
//     of saved senders (the account's default / sole sender auto-selects) instead
//     of free-text — so most fields fill themselves. The campaign name is an
//     editable title at the top; if left blank it falls back to the subject on save.
import { useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import {
  Sparkles,
  RefreshCw,
  X,
  Lightbulb,
  Eye,
  Check,
  CloudOff,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { RichTextEditor } from "@/components/ui/rich-text-editor";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { domainState } from "@/lib/domain";
import { sanitizeHtml } from "@/services/render";
import { useAiBudget } from "@/components/ai-budget-context";
import type { Audience, Campaign, Sender, SendingDomain } from "@/lib/types";

// Sentinel value for the trailing "add a sender" item in the From dropdown.
const ADD_SENDER = "__add_sender__";

// A sender can send once its domain is SES-verified or admin-overridden.
function senderVerified(s: Sender): boolean {
  return !!s.adminOverrideVerified || s.verificationStatus === "verified";
}

// Builds an honest "as delivered" preview: the body sanitized exactly as on send,
// with sample merge values filled in and a representative unsubscribe footer (the
// real one is appended per-recipient at send time).
function buildPreviewDoc(html: string): string {
  const body = sanitizeHtml(html)
    .replace(/\{\{\s*first_name\s*\}\}/gi, "Alex")
    .replace(/\{\{\s*last_name\s*\}\}/gi, "Rivera")
    .replace(/\{\{\s*email\s*\}\}/gi, "alex@example.com");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.6;margin:0;padding:24px}img{max-width:100%;height:auto}a{color:#2563eb}hr{border:none;border-top:1px solid #e5e5e5;margin:24px 0}blockquote{border-left:3px solid #e5e5e5;margin:0 0 0 0;padding-left:16px;color:#666}h1,h2,h3{line-height:1.25}</style></head><body>${body}<hr><p style="color:#8a8a8a;font-size:12px;line-height:1.5">You're receiving this because you subscribed to updates.<br><a href="#">Unsubscribe</a></p></body></html>`;
}

// Borderless input styling for the email-style header rows — the field reads as
// part of the message header, not a boxed form control.
const headerInputClass =
  "h-9 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent";

// How long the draft must sit unchanged before we quietly autosave it.
const AUTOSAVE_DELAY_MS = 10_000;

type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

// A subtle, non-blocking save indicator (like a doc editor's) shown next to the
// explicit Save button. Stays out of the way until there's something to report.
function AutosaveIndicator({ status }: { status: AutosaveStatus }) {
  if (status === "idle") return null;
  if (status === "error") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <CloudOff className="size-3.5" />
        Couldn&apos;t autosave — your changes are still here
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
      {status === "saving" ? (
        <>
          <OrbitLoader size={14} />
          Saving…
        </>
      ) : status === "saved" ? (
        <>
          <Check className="size-3.5" />
          Saved
        </>
      ) : (
        "Unsaved changes"
      )}
    </span>
  );
}

// One labeled row in the email-style header (mimics the top of a real email:
// a fixed label gutter on the left, the value filling the rest, and an optional
// secondary action — domain, AI helper, char count — pinned to the right).
function HeaderRow({
  label,
  htmlFor,
  action,
  children,
}: {
  label: string;
  htmlFor?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="flex items-center gap-3 border-b border-border px-4">
      <Label
        htmlFor={htmlFor}
        className="w-20 shrink-0 py-2.5 text-sm font-medium text-muted-foreground"
      >
        {label}
      </Label>
      <div className="flex min-w-0 flex-1 items-center gap-1.5">{children}</div>
      {action ? <div className="flex shrink-0 items-center gap-1">{action}</div> : null}
    </div>
  );
}

export type CampaignFormValues = {
  name: string;
  subject: string;
  previewText?: string;
  audienceId: string;
  sendingDomainId: string;
  senderId?: string;
  fromName: string;
  fromEmail: string;
  replyTo?: string;
  htmlBody: string;
  textBody?: string;
};

const TONES = [
  { value: "friendly", label: "Friendly" },
  { value: "professional", label: "Professional" },
  { value: "excited", label: "Excited" },
  { value: "casual", label: "Casual" },
  { value: "concise", label: "Concise" },
];

export function CampaignComposer({
  initial,
  onSave,
  onAutosave,
  submitLabel,
  titleBadge,
  titleActions,
}: {
  initial?: Campaign;
  onSave: (values: CampaignFormValues) => Promise<void>;
  // Optional: called automatically ~10s after the user stops editing, once the
  // draft is complete enough to persist. Should save quietly (no toast/navigation
  // churn). Omit to disable autosave.
  onAutosave?: (values: CampaignFormValues) => Promise<void>;
  submitLabel: string;
  // Optional chrome rendered alongside the editable title (e.g. a status badge
  // and page-level action buttons on the campaign detail page).
  titleBadge?: ReactNode;
  titleActions?: ReactNode;
}) {
  const api = useApi();
  // AI availability + the org's budget live in a shared context so the single
  // budget meter (in the sidebar) and this composer stay in sync. We refresh it
  // after each AI action and disable the AI buttons when the budget is spent.
  const { enabled: aiEnabled, budget: aiBudget, refresh: refreshAiBudget } = useAiBudget();
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [domains, setDomains] = useState<SendingDomain[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);

  // Inline "add a sender" dialog (so users never have to leave the composer).
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [qaDomainId, setQaDomainId] = useState("");
  const [qaName, setQaName] = useState("");
  const [qaEmail, setQaEmail] = useState("");
  const [qaEmailEdited, setQaEmailEdited] = useState(false);
  const [qaSaving, setQaSaving] = useState(false);

  // Every campaign starts in manual mode — a ready-to-write canvas. The AI draft
  // panel is opt-in via the prominent "Draft with AI" button, never a forced choice.
  const [mode, setMode] = useState<"ai" | "manual">("manual");

  // AI draft panel state.
  const [brief, setBrief] = useState("");
  const [tone, setTone] = useState("friendly");
  const [drafting, setDrafting] = useState(false);
  const [hasDrafted, setHasDrafted] = useState(false);

  // AI subject ideas.
  const [subjectIdeas, setSubjectIdeas] = useState<string[] | null>(null);
  const [loadingIdeas, setLoadingIdeas] = useState(false);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);

  // Autosave bookkeeping. The callback is held in a ref so the debounce
  // subscription can stay mounted once without re-subscribing on every render.
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus>("idle");
  const onAutosaveRef = useRef(onAutosave);
  onAutosaveRef.current = onAutosave;
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const { register, handleSubmit, setValue, watch, getValues, formState } =
    useForm<CampaignFormValues>({
      defaultValues: initial
        ? {
            name: initial.name,
            subject: initial.subject,
            previewText: initial.previewText ?? "",
            audienceId: initial.audienceId,
            sendingDomainId: initial.sendingDomainId,
            senderId: initial.senderId ?? "",
            fromName: initial.fromName,
            fromEmail: initial.fromEmail,
            replyTo: initial.replyTo ?? "",
            htmlBody: initial.htmlBody,
            textBody: initial.textBody ?? "",
          }
        : {
            name: "",
            subject: "",
            previewText: "",
            audienceId: "",
            sendingDomainId: "",
            senderId: "",
            fromName: "",
            fromEmail: "",
            replyTo: "",
            htmlBody: "",
            textBody: "",
          },
    });

  useEffect(() => {
    api
      .get<{ audiences: Audience[] }>("/api/audiences")
      .then((res) => setAudiences(res.audiences))
      .catch((err) => toast.error(err.message));
    api
      .get<{ domains: SendingDomain[] }>("/api/domains")
      .then((res) => setDomains(res.domains))
      .catch((err) => toast.error(err.message));
    api
      .get<{ senders: Sender[] }>("/api/senders")
      .then((res) => setSenders(res.senders))
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // True only when AI is configured but the org's budget is spent — gates the
  // AI buttons. AI being merely unconfigured is handled by `aiEnabled`.
  const aiExhausted = aiEnabled && aiBudget?.exhausted === true;

  // Smart default: a sole audience selects itself.
  useEffect(() => {
    if (!getValues("audienceId") && audiences.length === 1) {
      setValue("audienceId", audiences[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audiences]);

  const verifiedDomains = domains.filter((d) => domainState(d) === "verified");

  // Fills the From fields from a chosen sender. Takes the object (not an id) so it
  // also works for a freshly-created sender before its state update has flushed.
  function selectSender(s: Sender) {
    setValue("senderId", s.id);
    setValue("sendingDomainId", s.sendingDomainId);
    setValue("fromName", s.fromName);
    setValue("fromEmail", s.fromEmail);
    if (s.replyTo && !getValues("replyTo")?.trim()) setValue("replyTo", s.replyTo);
  }

  // Smart default: preselect a sender once they load — the one already on the draft
  // (matched by the saved From address), else the account default, else the sole
  // verified sender. Skips if the draft already has a sender chosen.
  useEffect(() => {
    if (getValues("senderId") || senders.length === 0) return;
    const savedEmail = getValues("fromEmail");
    const verified = senders.filter(senderVerified);
    const match =
      (savedEmail ? senders.find((s) => s.fromEmail === savedEmail) : undefined) ||
      verified.find((s) => s.isDefault) ||
      (verified.length === 1 ? verified[0] : undefined);
    if (match) selectSender(match);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senders]);

  const subject = watch("subject");
  const htmlBody = watch("htmlBody");
  const senderId = watch("senderId");
  const audienceId = watch("audienceId");

  // Base UI's <SelectValue /> renders the raw selected value (an id) unless the
  // root is given an items map of value→label. Map ids to friendly labels so the
  // From/To rows show the sender and segment, not their ids.
  const audienceItems = Object.fromEntries(audiences.map((a) => [a.id, a.name]));
  const senderItems = Object.fromEntries(
    senders.map((s) => [s.id, `${s.fromName} <${s.fromEmail}>`]),
  );

  // Autosave: persist the draft ~10s after the user stops making changes. We can
  // only save once everything the save endpoints require is present, so until
  // then the status quietly reads "Unsaved changes" rather than failing.
  useEffect(() => {
    if (!onAutosave) return;
    const subscription = watch(() => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      setAutosaveStatus((s) => (s === "saving" ? s : "pending"));
      autosaveTimer.current = setTimeout(async () => {
        const values = getValues();
        const ready =
          values.subject?.trim() &&
          values.audienceId &&
          values.sendingDomainId &&
          values.fromName?.trim() &&
          values.fromEmail?.trim() &&
          values.htmlBody?.trim();
        if (!ready || !onAutosaveRef.current) {
          setAutosaveStatus("idle");
          return;
        }
        setAutosaveStatus("saving");
        try {
          await onAutosaveRef.current({
            ...values,
            name: values.name?.trim() || values.subject.trim(),
          });
          setAutosaveStatus("saved");
        } catch {
          setAutosaveStatus("error");
        }
      }, AUTOSAVE_DELAY_MS);
    });
    return () => {
      subscription.unsubscribe();
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const noVerifiedDomain = domains.length > 0 && verifiedDomains.length === 0;

  async function handleDraft() {
    const b = brief.trim();
    if (!b) {
      toast.error("Tell the assistant what your email is about");
      return;
    }
    setDrafting(true);
    try {
      const audienceName = audiences.find((a) => a.id === getValues("audienceId"))?.name;
      const res = await api.post<{ subject: string; previewText: string; html: string }>(
        "/api/ai/draft",
        { brief: b, tone, audienceName, fromName: getValues("fromName") || undefined },
      );
      setValue("subject", res.subject);
      setValue("previewText", res.previewText);
      setValue("htmlBody", res.html);
      // Give the campaign a sensible title if the user hasn't named it yet.
      if (!getValues("name")?.trim()) setValue("name", res.subject);
      setHasDrafted(true);
      setSubjectIdeas(null);
      toast.success("Draft ready — tweak anything you like");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't draft right now");
    } finally {
      setDrafting(false);
      void refreshAiBudget();
    }
  }

  async function handleSubjectIdeas() {
    const b = brief.trim();
    const subj = getValues("subject")?.trim();
    const html = getValues("htmlBody")?.trim();
    if (!b && !subj && !html) {
      toast.error("Write a brief or some content first");
      return;
    }
    setLoadingIdeas(true);
    try {
      const res = await api.post<{ subjects: string[] }>("/api/ai/subject", {
        brief: b || undefined,
        subject: subj || undefined,
        html: html || undefined,
      });
      setSubjectIdeas(res.subjects);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't generate ideas");
    } finally {
      setLoadingIdeas(false);
      void refreshAiBudget();
    }
  }

  async function handlePreviewText() {
    const subj = getValues("subject")?.trim();
    const html = getValues("htmlBody")?.trim();
    if (!subj || !html) {
      toast.error("Add a subject and some content first");
      return;
    }
    setLoadingPreview(true);
    try {
      const res = await api.post<{ previewText: string }>("/api/ai/preview-text", {
        subject: subj,
        html,
      });
      setValue("previewText", res.previewText);
      toast.success("Preview text added");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't write preview text");
    } finally {
      setLoadingPreview(false);
      void refreshAiBudget();
    }
  }

  async function handleRewrite(text: string, action: string): Promise<string> {
    try {
      const res = await api.post<{ text: string }>("/api/ai/rewrite", { text, action });
      return res.text;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rewrite failed");
      return "";
    } finally {
      void refreshAiBudget();
    }
  }

  // Suggest news@<domain> as the from address until the user edits it.
  function onQaDomainChange(id: string) {
    setQaDomainId(id);
    if (!qaEmailEdited) {
      const d = verifiedDomains.find((x) => x.id === id);
      setQaEmail(d ? `news@${d.domain}` : "");
    }
  }

  function openQuickAdd() {
    // Pre-pick the sole verified domain so adding is one tap.
    const only = verifiedDomains.length === 1 ? verifiedDomains[0] : undefined;
    setQaDomainId(only?.id ?? "");
    setQaName("");
    setQaEmail(only ? `news@${only.domain}` : "");
    setQaEmailEdited(false);
    setQuickAddOpen(true);
  }

  async function handleQuickAddSender() {
    const domain = verifiedDomains.find((d) => d.id === qaDomainId);
    if (!domain) {
      toast.error("Pick a verified domain");
      return;
    }
    const fromName = qaName.trim();
    const fromEmail = qaEmail.trim().toLowerCase();
    if (!fromName) {
      toast.error("Add a from name");
      return;
    }
    if (!fromEmail.endsWith(`@${domain.domain}`)) {
      toast.error(`From email must end in @${domain.domain}`);
      return;
    }
    setQaSaving(true);
    try {
      const res = await api.post<{ sender: Sender }>("/api/senders", {
        sendingDomainId: domain.id,
        fromName,
        fromEmail,
      });
      setSenders((prev) => [res.sender, ...prev]);
      selectSender(res.sender);
      setQuickAddOpen(false);
      toast.success("Sender added");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't add sender");
    } finally {
      setQaSaving(false);
    }
  }

  const onSubmit = handleSubmit(async (values) => {
    // A manual save supersedes any pending autosave.
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    const missing: string[] = [];
    if (!values.subject?.trim()) missing.push("Subject");
    if (!values.audienceId) missing.push("Audience");
    if (!values.sendingDomainId) missing.push("Sending domain");
    if (!values.fromName?.trim()) missing.push("From name");
    if (!values.fromEmail?.trim()) missing.push("From email");
    if (!values.htmlBody?.trim()) missing.push("Email content");
    if (missing.length) {
      toast.error(`Please complete: ${missing.join(", ")}`);
      return;
    }
    const payload: CampaignFormValues = {
      ...values,
      name: values.name?.trim() || values.subject.trim(),
    };
    try {
      await onSave(payload);
      setAutosaveStatus("saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  });

  // --- Composer --------------------------------------------------------------
  return (
    <form onSubmit={onSubmit} className="space-y-6">
      {/* Editable page title — the campaign's internal name, now the heading.
          Reads as the page title but is fully editable in place. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <input
          aria-label="Campaign name"
          className="min-w-[12rem] flex-1 border-0 bg-transparent p-0 text-2xl font-semibold tracking-tight outline-none placeholder:text-muted-foreground/40 focus:outline-none focus-visible:outline-none focus-visible:ring-0"
          placeholder="Untitled campaign"
          {...register("name")}
        />
        {titleBadge}
        {titleActions ? (
          <div className="ml-auto flex shrink-0 items-center gap-2">{titleActions}</div>
        ) : null}
      </div>

      {noVerifiedDomain && (
        <Alert>
          <AlertTitle>You&apos;ll need a verified domain to send</AlertTitle>
          <AlertDescription>
            You can write and save this draft now.{" "}
            <Link href="/domains" className="font-medium underline underline-offset-4">
              Set up a sending domain
            </Link>{" "}
            when you&apos;re ready to send.
          </AlertDescription>
        </Alert>
      )}

      {aiEnabled && mode === "ai" && (
        <Card className="border-primary/20 bg-primary/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-primary" />
              {hasDrafted ? "Draft with AI" : "What's your email about?"}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Textarea
              rows={2}
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              placeholder="e.g. Announce our new billing dashboard. One clear call to action to try it."
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  if (!drafting) handleDraft();
                }
              }}
            />
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Tone</span>
                <Select value={tone} onValueChange={(v) => v && setTone(v)}>
                  <SelectTrigger size="sm" className="w-36">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TONES.map((t) => (
                      <SelectItem key={t.value} value={t.value}>
                        {t.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <Button type="button" onClick={handleDraft} disabled={drafting || aiExhausted}>
                {drafting ? (
                  <>
                    <OrbitLoader size={16} />
                    Writing your draft…
                  </>
                ) : hasDrafted ? (
                  <>
                    <RefreshCw />
                    Regenerate
                  </>
                ) : (
                  <>
                    <Sparkles />
                    Draft my email
                  </>
                )}
              </Button>
              {!hasDrafted && !aiExhausted && (
                <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter</span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Action bar — preview & AI, sitting above the message like an email
          client's toolbar. */}
      <div className="flex items-center justify-end gap-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => setPreviewOpen(true)}
          disabled={!htmlBody?.trim()}
        >
          <Eye />
          Preview
        </Button>
        {aiEnabled && mode !== "ai" && (
          <Button
            type="button"
            size="sm"
            onClick={() => setMode("ai")}
            className="d3-ai-cta"
          >
            <Sparkles className="d3-ai-spark" />
            Draft with AI
          </Button>
        )}
      </div>

      {/* The email surface: a header that mimics the top of a real email, with the
          body flowing straight beneath it — one continuous message, no seams. */}
      <div className="overflow-hidden rounded-xl border border-border bg-card shadow-sm">
        <HeaderRow label="From" htmlFor="senderSelect">
          {senders.length > 0 ? (
            <Select
              items={senderItems}
              value={senderId || null}
              onValueChange={(v) => {
                if (!v) return;
                if (v === ADD_SENDER) {
                  openQuickAdd();
                  return;
                }
                const s = senders.find((x) => x.id === v);
                if (s) selectSender(s);
              }}
            >
              <SelectTrigger
                id="senderSelect"
                aria-label="Sender"
                className="w-full border-0 bg-transparent px-0 shadow-none hover:bg-transparent focus-visible:ring-0 data-placeholder:text-muted-foreground dark:bg-transparent dark:hover:bg-transparent"
              >
                <SelectValue placeholder="Choose who this is from…" />
              </SelectTrigger>
              <SelectContent>
                {senders.map((s) => {
                  const verified = senderVerified(s);
                  return (
                    <SelectItem key={s.id} value={s.id} disabled={!verified}>
                      <span className="font-medium">{s.fromName}</span>{" "}
                      <span className="text-muted-foreground">&lt;{s.fromEmail}&gt;</span>
                      {!verified && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          · domain needs setup
                        </span>
                      )}
                    </SelectItem>
                  );
                })}
                <SelectItem value={ADD_SENDER} className="text-muted-foreground">
                  + Add a new sender…
                </SelectItem>
              </SelectContent>
            </Select>
          ) : (
            <button
              type="button"
              onClick={openQuickAdd}
              className="text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              + Add a sender
            </button>
          )}
        </HeaderRow>

        <HeaderRow label="Reply-To" htmlFor="replyTo">
          <Input
            id="replyTo"
            type="email"
            className={headerInputClass}
            placeholder="Where replies go — defaults to the From address"
            {...register("replyTo")}
          />
        </HeaderRow>

        <HeaderRow label="To">
          <Select
            items={audienceItems}
            value={audienceId || null}
            onValueChange={(v) => v && setValue("audienceId", v)}
          >
            <SelectTrigger
              aria-label="Audience"
              className="w-full border-0 bg-transparent px-0 shadow-none hover:bg-transparent focus-visible:ring-0 data-placeholder:text-muted-foreground dark:bg-transparent dark:hover:bg-transparent"
            >
              <SelectValue placeholder="Select a segment…" />
            </SelectTrigger>
            <SelectContent>
              {audiences.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </HeaderRow>

        <HeaderRow
          label="Subject"
          htmlFor="subject"
          action={
            <>
              {subject?.trim() && (
                <span
                  className={cn(
                    "text-xs tabular-nums",
                    subject.length > 60
                      ? "text-amber-600 dark:text-amber-500"
                      : "text-muted-foreground",
                  )}
                  title={
                    subject.length > 60
                      ? "Long subjects can get cut off in the inbox"
                      : undefined
                  }
                >
                  {subject.length}
                </span>
              )}
              {aiEnabled && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={handleSubjectIdeas}
                  disabled={loadingIdeas || aiExhausted}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {loadingIdeas ? <OrbitLoader size={16} /> : <Lightbulb />}
                  Ideas
                </Button>
              )}
            </>
          }
        >
          <Input
            id="subject"
            className={headerInputClass}
            placeholder="What's new in June"
            {...register("subject")}
          />
        </HeaderRow>

        {subjectIdeas && subjectIdeas.length > 0 && (
          <div className="space-y-1.5 border-b border-border bg-muted/30 px-4 py-2.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                Tap one to use it
              </span>
              <button
                type="button"
                onClick={() => setSubjectIdeas(null)}
                className="text-muted-foreground hover:text-foreground"
                aria-label="Dismiss suggestions"
              >
                <X className="size-3.5" />
              </button>
            </div>
            <div className="flex flex-col gap-1">
              {subjectIdeas.map((s, i) => (
                <button
                  key={i}
                  type="button"
                  onClick={() => {
                    setValue("subject", s);
                    setSubjectIdeas(null);
                  }}
                  className="rounded-md px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <HeaderRow
          label="Preview"
          htmlFor="previewText"
          action={
            aiEnabled ? (
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={handlePreviewText}
                disabled={loadingPreview || aiExhausted}
                className="text-muted-foreground hover:text-foreground"
              >
                {loadingPreview ? <OrbitLoader size={16} /> : <Sparkles />}
                Write for me
              </Button>
            ) : null
          }
        >
          <Input
            id="previewText"
            className={headerInputClass}
            placeholder="The grey snippet shown after the subject in the inbox"
            {...register("previewText")}
          />
        </HeaderRow>

        {/* Body — flows straight out of the header, sharing the same surface. */}
        <RichTextEditor
          value={htmlBody ?? ""}
          onChange={(html) => setValue("htmlBody", html)}
          onRewrite={aiEnabled && !aiExhausted ? handleRewrite : undefined}
          placeholder="Write your email, or describe it above and let AI draft it…"
          className="rounded-none border-0"
        />
      </div>

      <p className="text-xs text-muted-foreground">
        Use the <span className="font-medium">Personalize</span> menu to drop in{" "}
        {"{{first_name}}"}, {"{{last_name}}"}, or {"{{email}}"}. An unsubscribe footer is added
        automatically.
        {aiEnabled && !aiExhausted && " Select any text to rewrite it with AI."}
        {audiences.length === 0 && (
          <>
            {" "}No audiences yet —{" "}
            <Link href="/audiences" className="underline underline-offset-2 hover:text-foreground">
              import subscribers
            </Link>
            .
          </>
        )}
        {domains.length === 0 && (
          <>
            {" "}Need a sending address?{" "}
            <Link href="/domains" className="underline underline-offset-2 hover:text-foreground">
              Add a domain
            </Link>
            .
          </>
        )}
      </p>

      <div className="flex items-center gap-3">
        <Button type="submit" disabled={formState.isSubmitting}>
          {formState.isSubmitting ? (
            <>
              <OrbitLoader size={16} />
              Saving…
            </>
          ) : (
            submitLabel
          )}
        </Button>
        {onAutosave && <AutosaveIndicator status={autosaveStatus} />}
      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Preview</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            {subject?.trim() && (
              <div className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm">
                <span className="text-muted-foreground">Subject: </span>
                {subject}
              </div>
            )}
            <div className="overflow-hidden rounded-lg border border-border bg-white">
              <iframe
                title="Email preview"
                sandbox=""
                srcDoc={buildPreviewDoc(htmlBody ?? "")}
                className="h-[60vh] w-full border-0"
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Sample personalization shown. The unsubscribe footer is added automatically on send.
            </p>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={quickAddOpen} onOpenChange={setQuickAddOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Add a sender</DialogTitle>
          </DialogHeader>
          {verifiedDomains.length === 0 ? (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>You&apos;ll need a verified sending domain before you can add a sender.</p>
              <Button render={<Link href="/domains">Set up a domain</Link>} />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="qaDomain">Domain</Label>
                <Select
                  items={Object.fromEntries(verifiedDomains.map((d) => [d.id, d.domain]))}
                  value={qaDomainId || null}
                  onValueChange={(v) => v && onQaDomainChange(v)}
                >
                  <SelectTrigger id="qaDomain" aria-label="Domain" className="w-full">
                    <SelectValue placeholder="Pick a verified domain" />
                  </SelectTrigger>
                  <SelectContent>
                    {verifiedDomains.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.domain}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qaName">From name</Label>
                <Input
                  id="qaName"
                  placeholder="Jane from Acme"
                  value={qaName}
                  onChange={(e) => setQaName(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The sender name people see in their inbox.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="qaEmail">From email</Label>
                <Input
                  id="qaEmail"
                  placeholder="news@news.acme.com"
                  value={qaEmail}
                  onChange={(e) => {
                    setQaEmailEdited(true);
                    setQaEmail(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {qaDomainId
                    ? `Must be an address at @${verifiedDomains.find((d) => d.id === qaDomainId)?.domain}.`
                    : "Must be an address at your domain."}
                </p>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button type="button" variant="ghost" onClick={() => setQuickAddOpen(false)}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleQuickAddSender} disabled={qaSaving}>
                  {qaSaving && <OrbitLoader size={16} />}
                  Add sender
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </form>
  );
}
