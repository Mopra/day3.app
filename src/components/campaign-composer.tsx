"use client";

// The campaign authoring experience. Replaces the old raw-HTML <CampaignForm>.
// Goals: make creating an email feel near-automatic for non-technical users.
//   - A start chooser ("Let AI draft it" / "Write it myself") for new campaigns.
//   - AI helpers: draft from a brief, subject ideas, auto preview text, and
//     select-to-rewrite (wired into the editor's bubble menu).
//   - A true WYSIWYG editor whose output is exactly what gets sent.
//   - Smart defaults: a sole audience / sole verified domain are auto-selected,
//     from name/email are filled from the domain, and the internal name mirrors
//     the subject unless edited — so most fields fill themselves.
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import {
  Sparkles,
  PenLine,
  Loader2,
  RefreshCw,
  X,
  Lightbulb,
  ChevronRight,
  Eye,
} from "lucide-react";
import { Button } from "@/components/ui/button";
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
import type { Audience, Campaign, SendingDomain } from "@/lib/types";

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

export type CampaignFormValues = {
  name: string;
  subject: string;
  previewText?: string;
  audienceId: string;
  sendingDomainId: string;
  fromName: string;
  fromEmail: string;
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
  submitLabel,
}: {
  initial?: Campaign;
  onSave: (values: CampaignFormValues) => Promise<void>;
  submitLabel: string;
}) {
  const api = useApi();
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [domains, setDomains] = useState<SendingDomain[]>([]);
  const [aiEnabled, setAiEnabled] = useState(false);

  // null = show the start chooser (new campaigns only). Existing drafts skip it.
  const [mode, setMode] = useState<"ai" | "manual" | null>(initial ? "manual" : null);

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

  // Existing campaigns already have a name; don't auto-sync it from the subject.
  const nameTouched = useRef(Boolean(initial));

  const { register, handleSubmit, setValue, watch, getValues, formState } =
    useForm<CampaignFormValues>({
      defaultValues: initial
        ? {
            name: initial.name,
            subject: initial.subject,
            previewText: initial.previewText ?? "",
            audienceId: initial.audienceId,
            sendingDomainId: initial.sendingDomainId,
            fromName: initial.fromName,
            fromEmail: initial.fromEmail,
            htmlBody: initial.htmlBody,
            textBody: initial.textBody ?? "",
          }
        : {
            name: "",
            subject: "",
            previewText: "",
            audienceId: "",
            sendingDomainId: "",
            fromName: "",
            fromEmail: "",
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
      .get<{ enabled: boolean }>("/api/ai/status")
      .then((res) => {
        setAiEnabled(res.enabled);
        // No AI configured + a brand-new campaign → skip the chooser entirely.
        if (!res.enabled) setMode((m) => (m === null ? "manual" : m));
      })
      .catch(() => setMode((m) => (m === null ? "manual" : m)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Smart default: a sole audience selects itself.
  useEffect(() => {
    if (!getValues("audienceId") && audiences.length === 1) {
      setValue("audienceId", audiences[0].id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audiences]);

  // Smart default: a sole verified domain selects itself and fills from name/email.
  const verifiedDomains = domains.filter((d) => domainState(d) === "verified");
  useEffect(() => {
    if (!getValues("sendingDomainId") && verifiedDomains.length === 1) {
      const d = verifiedDomains[0];
      setValue("sendingDomainId", d.id);
      if (d.fromName && !getValues("fromName")) setValue("fromName", d.fromName);
      if (d.fromEmail && !getValues("fromEmail")) setValue("fromEmail", d.fromEmail);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [domains]);

  const subject = watch("subject");
  const htmlBody = watch("htmlBody");
  const sendingDomainId = watch("sendingDomainId");
  const audienceId = watch("audienceId");

  // Internal name mirrors the subject until the user edits it explicitly.
  useEffect(() => {
    if (!nameTouched.current) setValue("name", subject ?? "");
  }, [subject, setValue]);

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
      if (!nameTouched.current) setValue("name", res.subject);
      setHasDrafted(true);
      setSubjectIdeas(null);
      toast.success("Draft ready — tweak anything you like");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't draft right now");
    } finally {
      setDrafting(false);
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
    }
  }

  async function handleRewrite(text: string, action: string): Promise<string> {
    try {
      const res = await api.post<{ text: string }>("/api/ai/rewrite", { text, action });
      return res.text;
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rewrite failed");
      return "";
    }
  }

  const onSubmit = handleSubmit(async (values) => {
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
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  });

  // --- Start chooser (new campaigns, AI available) ---------------------------
  if (mode === null) {
    return (
      <div className="grid gap-4 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setMode("ai")}
          className="group flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-6 text-left transition-all hover:border-primary/40 hover:bg-primary/5 hover:shadow-md focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="flex size-11 items-center justify-center rounded-lg bg-primary/10 text-primary">
            <Sparkles className="size-5" />
          </span>
          <div className="space-y-1">
            <h3 className="flex items-center gap-1 font-medium">
              Let AI draft it
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </h3>
            <p className="text-sm text-muted-foreground">
              Describe your update in a sentence — we&apos;ll write the subject, preview, and a
              formatted draft you can tweak.
            </p>
          </div>
        </button>
        <button
          type="button"
          onClick={() => setMode("manual")}
          className="group flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-6 text-left transition-all hover:border-foreground/20 hover:bg-muted/40 hover:shadow-md focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          <span className="flex size-11 items-center justify-center rounded-lg bg-muted text-foreground">
            <PenLine className="size-5" />
          </span>
          <div className="space-y-1">
            <h3 className="flex items-center gap-1 font-medium">
              Write it myself
              <ChevronRight className="size-4 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
            </h3>
            <p className="text-sm text-muted-foreground">
              Start from a blank canvas with rich formatting and AI help whenever you want it.
            </p>
          </div>
        </button>
      </div>
    );
  }

  // --- Composer --------------------------------------------------------------
  return (
    <form onSubmit={onSubmit} className="space-y-6">
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
              <Button type="button" onClick={handleDraft} disabled={drafting}>
                {drafting ? (
                  <>
                    <Loader2 className="animate-spin" />
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
              {!hasDrafted && (
                <span className="text-xs text-muted-foreground">⌘/Ctrl + Enter</span>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Subject &amp; preview</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="subject">Subject</Label>
              <div className="flex items-center gap-2">
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
                    disabled={loadingIdeas}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    {loadingIdeas ? <Loader2 className="animate-spin" /> : <Lightbulb />}
                    Ideas
                  </Button>
                )}
              </div>
            </div>
            <Input
              id="subject"
              placeholder="What's new in June"
              {...register("subject")}
            />
            {subjectIdeas && subjectIdeas.length > 0 && (
              <div className="space-y-1.5 rounded-lg border border-border bg-muted/30 p-2.5">
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
          </div>
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="previewText">Preview text (optional)</Label>
              {aiEnabled && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={handlePreviewText}
                  disabled={loadingPreview}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {loadingPreview ? <Loader2 className="animate-spin" /> : <Sparkles />}
                  Write for me
                </Button>
              )}
            </div>
            <Input
              id="previewText"
              placeholder="The grey snippet shown after the subject in the inbox"
              {...register("previewText")}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
          <CardTitle className="text-base">Content</CardTitle>
          <div className="flex items-center gap-2">
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
              <Button type="button" variant="outline" size="sm" onClick={() => setMode("ai")}>
                <Sparkles />
                Draft with AI
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <RichTextEditor
            value={htmlBody ?? ""}
            onChange={(html) => setValue("htmlBody", html)}
            onRewrite={aiEnabled ? handleRewrite : undefined}
            placeholder="Write your email, or describe it above and let AI draft it…"
          />
          <p className="text-xs text-muted-foreground">
            Use the <span className="font-medium">Personalize</span> menu to drop in{" "}
            {"{{first_name}}"}, {"{{last_name}}"}, or {"{{email}}"}. An unsubscribe footer is added
            automatically.
            {aiEnabled && " Select any text to rewrite it with AI."}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sending</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label>Audience</Label>
            <Select
              value={audienceId || null}
              onValueChange={(v) => v && setValue("audienceId", v)}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select audience" />
              </SelectTrigger>
              <SelectContent>
                {audiences.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {audiences.length === 0 && (
              <p className="text-xs text-muted-foreground">
                No audiences yet.{" "}
                <Link href="/audiences" className="underline underline-offset-2 hover:text-foreground">
                  Import subscribers
                </Link>
                .
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Sending domain</Label>
            <Select
              value={sendingDomainId || null}
              onValueChange={(v) => {
                if (!v) return;
                setValue("sendingDomainId", v);
                const domain = domains.find((d) => d.id === v);
                if (domain?.fromName) setValue("fromName", domain.fromName);
                if (domain?.fromEmail) setValue("fromEmail", domain.fromEmail);
              }}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select domain" />
              </SelectTrigger>
              <SelectContent>
                {domains.map((d) => {
                  const verified = domainState(d) === "verified";
                  return (
                    <SelectItem key={d.id} value={d.id} disabled={!verified}>
                      <span>{d.domain}</span>
                      {!verified && (
                        <span className="text-xs text-muted-foreground">needs setup</span>
                      )}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
            {noVerifiedDomain ? (
              <p className="text-xs text-muted-foreground">
                You can only send from a verified domain.{" "}
                <Link href="/domains" className="underline underline-offset-2 hover:text-foreground">
                  Finish domain setup
                </Link>
                .
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Don&apos;t see your domain?{" "}
                <Link href="/domains" className="underline underline-offset-2 hover:text-foreground">
                  Add or verify a domain
                </Link>
                .
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="fromName">From name</Label>
            <Input id="fromName" placeholder="Jane from Acme" {...register("fromName")} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fromEmail">From email</Label>
            <Input id="fromEmail" placeholder="jane@updates.acme.com" {...register("fromEmail")} />
          </div>
          <div className="space-y-2 md:col-span-2">
            <Label htmlFor="name">Internal name (only you see this)</Label>
            <Input
              id="name"
              placeholder="Defaults to the subject"
              {...register("name", {
                onChange: () => {
                  nameTouched.current = true;
                },
              })}
            />
          </div>
        </CardContent>
      </Card>

      <Button type="submit" disabled={formState.isSubmitting}>
        {formState.isSubmitting ? (
          <>
            <Loader2 className="animate-spin" />
            Saving…
          </>
        ) : (
          submitLabel
        )}
      </Button>

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
    </form>
  );
}
