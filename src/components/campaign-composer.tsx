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
  Lock,
  AlertTriangle,
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
import { sanitizeHtml, DEFAULT_FOOTER_TEXT } from "@/services/render";
import { useAiBudget } from "@/components/ai-budget-context";
import type { Account, Audience, Campaign, Sender, SendingDomain } from "@/lib/types";

// Sentinel value for the trailing "add a sender" item in the From dropdown.
const ADD_SENDER = "__add_sender__";

// A sender can send once its domain is SES-verified or admin-overridden.
function senderVerified(s: Sender): boolean {
  return !!s.adminOverrideVerified || s.verificationStatus === "verified";
}

// Minimal HTML escape for plain footer wording dropped into the preview srcDoc.
function escapeForPreview(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Fills {{merge_tags}} with representative sample values so the preview reads like
// a real, personalized message rather than showing raw tokens. Function replacers
// avoid String.replace treating "$" in values as a pattern; the optional
// `(?:\|[^}]*)?` swallows a fallback (e.g. {{first_name|there}}) so the preview
// shows the "field is filled" case.
function fillMergeTags(s: string, company: string): string {
  return s
    .replace(/\{\{\s*first_name\s*(?:\|[^}]*)?\}\}/gi, () => "Alex")
    .replace(/\{\{\s*last_name\s*(?:\|[^}]*)?\}\}/gi, () => "Rivera")
    .replace(/\{\{\s*email\s*(?:\|[^}]*)?\}\}/gi, () => "alex@example.com")
    .replace(/\{\{\s*company_name\s*(?:\|[^}]*)?\}\}/gi, () => company);
}

// Flattens sanitized body HTML to a one-line plain-text snippet — used as the
// inbox-list preview line when the campaign has no explicit preview text, exactly
// as real mail clients fall back to the start of the body.
function htmlToSnippet(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();
}

// A small, stable palette + hash so a given sender always gets the same avatar
// colour (like Gmail/Apple Mail). Deterministic — no Math.random — so the preview
// doesn't flicker between renders.
const AVATAR_COLORS = [
  "#ef4444", "#f97316", "#d97706", "#16a34a", "#0891b2",
  "#2563eb", "#7c3aed", "#db2777", "#0d9488", "#4f46e5",
];
function avatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_COLORS[h % AVATAR_COLORS.length];
}

// Builds an honest "as delivered" preview: the body sanitized exactly as on send,
// with sample merge values filled in, the editable footer wording, and the real
// company name + mailing address (the per-recipient unsubscribe link is appended
// at send). Falls back to bracketed hints when the address isn't set yet.
function buildPreviewDoc(
  html: string,
  footerText: string,
  companyName: string,
  companyAddress: string,
): string {
  const company = companyName.trim() || "Your Company";
  const body = fillMergeTags(sanitizeHtml(html), company);
  const footer = escapeForPreview(fillMergeTags(footerText.trim() || DEFAULT_FOOTER_TEXT, company));
  const addr = companyAddress.trim()
    ? escapeForPreview(companyAddress)
    : "[Add your business address]";
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;line-height:1.6;margin:0;padding:24px}img{max-width:100%;height:auto}a{color:#2563eb}hr{border:none;border-top:1px solid #e5e5e5;margin:24px 0}blockquote{border-left:3px solid #e5e5e5;margin:0 0 0 0;padding-left:16px;color:#666}h1,h2,h3{line-height:1.25}</style></head><body>${body}<hr><p style="color:#8a8a8a;font-size:12px;line-height:1.5">${footer}<br>${addr}<br><a href="#">Unsubscribe</a></p></body></html>`;
}

// Borderless input styling for the email-style header rows — the field reads as
// part of the message header, not a boxed form control.
const headerInputClass =
  "h-9 rounded-none border-0 bg-transparent px-0 shadow-none focus-visible:ring-0 dark:bg-transparent";

// How long the draft must sit unchanged before we autosave it. Short, so saving
// feels near-instant — there's no manual Save button.
const AUTOSAVE_DELAY_MS = 800;

type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

// The "this saves itself" indicator (like a doc editor's). With no Save button,
// this is how the user knows their work is safe — so it's always present once
// there's anything to report. "pending" (waiting out the debounce) and "saving"
// both read as "Saving…" so editing feels continuously saved.
function AutosaveIndicator({ status }: { status: AutosaveStatus }) {
  if (status === "idle") return null;
  if (status === "error") {
    return (
      <span className="flex items-center gap-1.5 text-xs text-destructive">
        <CloudOff className="size-3.5" />
        Couldn&apos;t save — your changes are still here
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
          Saving…
        </>
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
    <div className="flex items-center gap-3">
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
  footerText?: string;
};

export function CampaignComposer({
  initial,
  onAutosave,
  titleBadge,
  titleActions,
}: {
  initial?: Campaign;
  // Called a beat after each edit to persist the draft (partial drafts are fine).
  // This is the only save mechanism — there is no manual Save button. Should save
  // quietly (no toast/navigation churn). Omit to disable autosave.
  onAutosave?: (values: CampaignFormValues) => Promise<void>;
  // Optional chrome rendered alongside the editable title (e.g. a status badge
  // and page-level action buttons on the campaign detail page).
  titleBadge?: ReactNode;
  titleActions?: ReactNode;
}) {
  const api = useApi();
  // AI availability + the org's budget live in a shared context so the single
  // budget meter (in the sidebar) and this composer stay in sync. We refresh it
  // after each AI action and disable the AI buttons when the budget is spent.
  const {
    enabled: aiEnabled,
    configured: aiConfigured,
    planAi,
    budget: aiBudget,
    refresh: refreshAiBudget,
  } = useAiBudget();
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [domains, setDomains] = useState<SendingDomain[]>([]);
  const [senders, setSenders] = useState<Sender[]>([]);
  // The org account — its name and mailing address fill the footer (the address
  // is legally required). Loaded so the preview shows real values, not samples.
  const [account, setAccount] = useState<Account | null>(null);

  // Inline "add your business address" dialog, so a missing address can be fixed
  // without leaving the composer.
  const [addressOpen, setAddressOpen] = useState(false);
  const [addressDraft, setAddressDraft] = useState("");
  const [savingAddress, setSavingAddress] = useState(false);

  // Inline "rename your organization" dialog — the company name shows in every
  // footer via {{company_name}}, and the default ("My Organization") needs fixing.
  const [nameOpen, setNameOpen] = useState(false);
  const [nameDraft, setNameDraft] = useState("");
  const [savingName, setSavingName] = useState(false);

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
  // True when there are edits not yet persisted — gates the flush-on-unmount.
  const autosaveDirty = useRef(false);

  const { register, setValue, watch, getValues } =
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
            footerText: initial.footerText ?? DEFAULT_FOOTER_TEXT,
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
            footerText: DEFAULT_FOOTER_TEXT,
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
    api
      .get<{ account: Account }>("/api/account")
      .then((res) => setAccount(res.account))
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

  const name = watch("name");
  const subject = watch("subject");
  const previewText = watch("previewText");
  const htmlBody = watch("htmlBody");
  const footerText = watch("footerText");
  const senderId = watch("senderId");
  const audienceId = watch("audienceId");
  const fromName = watch("fromName");
  const fromEmail = watch("fromEmail");

  // Real footer values from the account. Company name is the org name; the
  // mailing address is legally required and may not be set yet.
  const companyName = account?.name ?? "";
  const companyAddress = account?.companyAddress?.trim() ?? "";
  // Only flag a missing address once the account has actually loaded (account
  // !== null), so we don't flash a warning before the fetch resolves.
  const addressMissing = account !== null && !companyAddress;
  // The Clerk default org name — emails reading "from My Organization" look unset.
  const companyNameDefault = account !== null && companyName.trim() === "My Organization";

  // Derived "how it lands in the inbox" values for the preview dialog. The from
  // name/address, subject, and snippet are exactly what the recipient sees in
  // their mail client's list and reading pane; the snippet falls back to the start
  // of the body (with sample merge values) when no preview text is set, just as
  // real clients do.
  const previewCompany = companyName.trim() || "Your Company";
  const fromDisplayName = fromName?.trim() || "Your name";
  const fromDisplayEmail = fromEmail?.trim() || "you@yourdomain.com";
  const avatarInitial = (fromName?.trim() || fromEmail?.trim() || "?")
    .charAt(0)
    .toUpperCase();
  const subjectDisplay = subject?.trim() || "(no subject)";
  const inboxSnippet =
    fillMergeTags(previewText?.trim() ?? "", previewCompany) ||
    htmlToSnippet(fillMergeTags(sanitizeHtml(htmlBody ?? ""), previewCompany));

  // Base UI's <SelectValue /> renders the raw selected value (an id) unless the
  // root is given an items map of value→label. Map ids to friendly labels so the
  // From/To rows show the sender and segment, not their ids.
  const audienceItems = Object.fromEntries(audiences.map((a) => [a.id, a.name]));
  const senderItems = Object.fromEntries(
    senders.map((s) => [s.id, `${s.fromName} <${s.fromEmail}>`]),
  );

  // Autosave: persist the draft a beat after each edit — the only save mechanism,
  // so there's no Save button. Partial drafts are allowed (the API stores whatever
  // is filled in so far), so we save as soon as the user has typed anything worth
  // keeping. The pending edit is flushed on unmount so leaving the page mid-edit
  // never drops a keystroke.
  useEffect(() => {
    if (!onAutosave) return;

    // Has the user actually authored something? Auto-selected defaults (a sole
    // audience/sender) don't count — we don't want to create an empty draft just
    // because the page was opened.
    const worthSaving = (v: CampaignFormValues) =>
      !!(v.subject?.trim() || v.htmlBody?.trim() || v.name?.trim() || v.previewText?.trim());

    const save = async () => {
      const values = getValues();
      if (!worthSaving(values) || !onAutosaveRef.current) {
        autosaveDirty.current = false;
        setAutosaveStatus("idle");
        return;
      }
      autosaveDirty.current = false;
      setAutosaveStatus("saving");
      try {
        await onAutosaveRef.current({
          ...values,
          name: values.name?.trim() || values.subject?.trim() || "",
        });
        setAutosaveStatus("saved");
      } catch {
        autosaveDirty.current = true;
        setAutosaveStatus("error");
      }
    };

    const subscription = watch(() => {
      if (!worthSaving(getValues())) return;
      autosaveDirty.current = true;
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      setAutosaveStatus((s) => (s === "saving" ? s : "pending"));
      autosaveTimer.current = setTimeout(() => void save(), AUTOSAVE_DELAY_MS);
    });

    return () => {
      subscription.unsubscribe();
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      // Flush any pending edit so navigating away doesn't lose it. Fire-and-forget:
      // the component is unmounting, so we can't await.
      if (autosaveDirty.current) void save();
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
        { brief: b, audienceName, fromName: getValues("fromName") || undefined },
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

  async function handleRewrite(text: string, instruction: string): Promise<string> {
    try {
      const res = await api.post<{ text: string }>("/api/ai/rewrite", { text, instruction });
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

  function openAddress() {
    setAddressDraft(account?.companyAddress ?? "");
    setAddressOpen(true);
  }

  async function handleSaveAddress() {
    const value = addressDraft.trim();
    if (!value) {
      toast.error("Enter your business address");
      return;
    }
    setSavingAddress(true);
    try {
      await api.patch("/api/account", { companyAddress: value });
      setAccount((prev) => (prev ? { ...prev, companyAddress: value } : prev));
      setAddressOpen(false);
      toast.success("Address saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save address");
    } finally {
      setSavingAddress(false);
    }
  }

  function openName() {
    setNameDraft(account?.name ?? "");
    setNameOpen(true);
  }

  async function handleSaveName() {
    const value = nameDraft.trim();
    if (!value) {
      toast.error("Enter your company name");
      return;
    }
    setSavingName(true);
    try {
      await api.patch("/api/account", { name: value });
      setAccount((prev) => (prev ? { ...prev, name: value } : prev));
      setNameOpen(false);
      toast.success("Company name saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save name");
    } finally {
      setSavingName(false);
    }
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

  // --- Composer --------------------------------------------------------------
  return (
    // No submit button — the draft autosaves. Swallow form submits (e.g. Enter in
    // a field) so they can't navigate or reload; autosave already has the changes.
    <form onSubmit={(e) => e.preventDefault()} className="space-y-6">
      {/* Full-width content header — the (editable) page title and any page-level
          action buttons. Spans the full width; the message column below is the
          narrower email-width column. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border pb-4">
        {/* Title + badge group. The input auto-sizes to its content (a hidden
            sizer span mirrors the text) so the status badge hugs the title
            instead of being pushed to the far edge by a flex-1 field. */}
        <div className="flex min-w-0 items-center gap-x-3">
          <div className="grid max-w-full items-center text-2xl font-semibold tracking-tight">
            <span
              aria-hidden
              className="invisible col-start-1 row-start-1 min-w-[12rem] max-w-full whitespace-pre"
            >
              {name?.trim() ? name : "Untitled campaign"}
            </span>
            <input
              aria-label="Campaign name"
              size={1}
              className="col-start-1 row-start-1 w-full min-w-0 border-0 bg-transparent p-0 outline-none placeholder:text-muted-foreground/40 focus:outline-none focus-visible:outline-none focus-visible:ring-0"
              placeholder="Untitled campaign"
              {...register("name")}
            />
          </div>
          {titleBadge}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-3">
          {onAutosave && <AutosaveIndicator status={autosaveStatus} />}
          {titleActions}
        </div>
      </div>

      {/* Message column — constrained to a typical email body width. */}
      <div className="mx-auto w-full max-w-[600px] space-y-6">

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
          <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
            <CardTitle className="flex items-center gap-2 text-base">
              <Sparkles className="size-4 text-primary" />
              {hasDrafted ? "Draft with AI" : "What's your email about?"}
            </CardTitle>
            <button
              type="button"
              onClick={() => setMode("manual")}
              className="-mr-1 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
              aria-label="Close AI assistant"
            >
              <X className="size-4" />
            </button>
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
            className="d3-ai-cta h-6 px-2"
          >
            <Sparkles className="d3-ai-spark" />
            Draft with AI
          </Button>
        )}
        {/* AI is configured but the org's plan doesn't include it (free/1k/5k):
            offer the upgrade path instead of the AI button. */}
        {aiConfigured && !planAi && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="h-6 px-2"
            title="The AI assistant is available on the 10k plan and up"
            render={
              <Link href="/billing">
                <Sparkles />
                Unlock AI
              </Link>
            }
          />
        )}
      </div>

      {/* The email surface: a header that mimics the top of a real email, with the
          body flowing straight beneath it. Borderless and flat — the rows and body
          read as one continuous message, not a boxed form. */}
      <div>
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
          <div className="space-y-1.5 rounded-lg bg-muted/40 px-3 py-2.5">
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
          className="rounded-none border-0 bg-transparent"
        />

        {/* Footer — shown in the message itself. The wording is editable; the
            mailing address and unsubscribe link are appended automatically at
            send time (required by law) and can't be edited or removed. */}
        <div className="border-t border-border px-6 py-4">
          <Textarea
            aria-label="Footer text"
            rows={2}
            placeholder={DEFAULT_FOOTER_TEXT}
            className="resize-none border-0 bg-transparent px-0 text-xs text-muted-foreground shadow-none focus-visible:ring-0 dark:bg-transparent"
            {...register("footerText")}
          />
          <div className="mt-1.5 space-y-1 text-xs text-muted-foreground/70">
            {companyNameDefault ? (
              <p className="flex flex-wrap items-center gap-1.5 text-amber-600 dark:text-amber-500">
                <AlertTriangle className="size-3 shrink-0" />
                Emails show as &quot;My Organization&quot; — set your company name.
                <button
                  type="button"
                  onClick={openName}
                  className="font-medium underline underline-offset-2 hover:text-foreground"
                >
                  Set name
                </button>
              </p>
            ) : companyName ? (
              <p className="flex flex-wrap items-center gap-1.5">
                <Lock className="size-3 shrink-0" />
                <span>
                  <code>{"{{company_name}}"}</code> = {companyName}
                </span>
                <button
                  type="button"
                  onClick={openName}
                  className="text-muted-foreground/50 underline underline-offset-2 hover:text-foreground"
                >
                  edit
                </button>
              </p>
            ) : null}
            {addressMissing ? (
              <p className="flex flex-wrap items-center gap-1.5 text-amber-600 dark:text-amber-500">
                <AlertTriangle className="size-3 shrink-0" />
                Add your business address — it&apos;s required by law in every email.
                <button
                  type="button"
                  onClick={openAddress}
                  className="font-medium underline underline-offset-2 hover:text-foreground"
                >
                  Add it now
                </button>
              </p>
            ) : (
              <p className="flex items-center gap-1.5">
                <Lock className="size-3 shrink-0" />
                <span>{companyAddress || "Your business address"}</span>
                {companyAddress && (
                  <button
                    type="button"
                    onClick={openAddress}
                    className="text-muted-foreground/50 underline underline-offset-2 hover:text-foreground"
                  >
                    edit
                  </button>
                )}
              </p>
            )}
            <p className="flex items-center gap-1.5">
              <Lock className="size-3 shrink-0" />
              <span className="underline underline-offset-2">Unsubscribe</span>
              <span className="text-muted-foreground/50">· added automatically</span>
            </p>
          </div>
        </div>
      </div>

      {(audiences.length === 0 || domains.length === 0) && (
        <p className="text-xs text-muted-foreground">
          {audiences.length === 0 && (
            <>
              No audiences yet —{" "}
              <Link href="/audiences" className="underline underline-offset-2 hover:text-foreground">
                import subscribers
              </Link>
              .
            </>
          )}
          {domains.length === 0 && (
            <>
              {audiences.length === 0 ? " " : ""}Need a sending address?{" "}
              <Link href="/domains" className="underline underline-offset-2 hover:text-foreground">
                Add a domain
              </Link>
              .
            </>
          )}
        </p>
      )}

      </div>

      <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
        <DialogContent className="gap-0 overflow-hidden p-0 sm:max-w-2xl">
          {/* Mail-client chrome bar — frames everything below as an inbox view. */}
          <DialogHeader className="border-b border-border bg-muted/40 px-4 py-2.5">
            <DialogTitle className="flex items-center gap-2 text-sm font-medium">
              <Eye className="size-4 text-muted-foreground" />
              Inbox preview
            </DialogTitle>
          </DialogHeader>

          <div className="max-h-[80vh] overflow-y-auto">
            {/* The inbox list row — how the message lands in the list, before it's
                opened: sender, subject, and the grey preview snippet. */}
            <div className="border-b border-border px-4 py-3">
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/60">
                In the inbox
              </p>
              <div className="flex items-start gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
                <span
                  aria-hidden
                  className="mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold text-white"
                  style={{ backgroundColor: avatarColor(fromDisplayName) }}
                >
                  {avatarInitial}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-sm font-semibold text-foreground">
                      {fromDisplayName}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">Now</span>
                  </div>
                  <p className="truncate text-sm font-medium text-foreground">
                    {subjectDisplay}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">
                    {inboxSnippet || "No preview text yet"}
                  </p>
                </div>
              </div>
            </div>

            {/* The opened message — reading-pane header (subject, sender, recipient,
                time) above the email body rendered exactly as it sends. */}
            <div className="px-5 pt-5">
              <h2 className="font-heading text-xl font-semibold leading-snug text-foreground">
                {subjectDisplay}
              </h2>
              <div className="mt-4 flex items-center gap-3">
                <span
                  aria-hidden
                  className="flex size-10 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
                  style={{ backgroundColor: avatarColor(fromDisplayName) }}
                >
                  {avatarInitial}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-x-1.5">
                    <span className="text-sm font-semibold text-foreground">
                      {fromDisplayName}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      &lt;{fromDisplayEmail}&gt;
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground">to me</p>
                </div>
                <span className="shrink-0 self-start text-xs text-muted-foreground">Now</span>
              </div>
            </div>

            <div className="mt-4 border-t border-border bg-white">
              <iframe
                title="Email preview"
                sandbox=""
                srcDoc={buildPreviewDoc(htmlBody ?? "", footerText ?? "", companyName, companyAddress)}
                className="h-[50vh] w-full border-0"
              />
            </div>
          </div>

          <p className="border-t border-border bg-muted/30 px-4 py-2 text-xs text-muted-foreground">
            Sample personalization shown. The unsubscribe footer is added automatically on send.
          </p>
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

      <Dialog open={addressOpen} onOpenChange={setAddressOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Your business address</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Anti-spam laws (CAN-SPAM, GDPR) require a physical mailing address in every
              email. It&apos;s added to the footer of all your campaigns.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="companyAddress">Address</Label>
              <Textarea
                id="companyAddress"
                rows={3}
                placeholder="Acme Inc, 123 Main St, Copenhagen, DK"
                value={addressDraft}
                onChange={(e) => setAddressDraft(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setAddressOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSaveAddress} disabled={savingAddress}>
                {savingAddress && <OrbitLoader size={16} />}
                Save address
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      <Dialog open={nameOpen} onOpenChange={setNameOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Company name</DialogTitle>
          </DialogHeader>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              Your organization&apos;s name. It appears in the footer of every email (the{" "}
              <code>{"{{company_name}}"}</code> tag) and across your workspace.
            </p>
            <div className="space-y-1.5">
              <Label htmlFor="companyName">Name</Label>
              <Input
                id="companyName"
                placeholder="Acme Inc"
                value={nameDraft}
                autoFocus
                onChange={(e) => setNameDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (!savingName) handleSaveName();
                  }
                }}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" onClick={() => setNameOpen(false)}>
                Cancel
              </Button>
              <Button type="button" onClick={handleSaveName} disabled={savingName}>
                {savingName && <OrbitLoader size={16} />}
                Save name
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </form>
  );
}
