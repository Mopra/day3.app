"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  ChevronDown,
  CloudOff,
  Copy,
  ExternalLink,
  ImagePlus,
  ListChecks,
  Loader2,
  Palette,
  RotateCcw,
  Share2,
  SlidersHorizontal,
  Sparkles,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RowActions } from "@/components/ui/data-list";
import { MenuItem } from "@/components/ui/menu";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PublicFormView } from "@/components/public-form-view";
import { FormFieldsEditor } from "@/components/form-fields-editor";
import { ColorField, SliderField } from "@/components/ui/color-field";
import { compressImageForEmail } from "@/lib/image-compress";
import { DEFAULT_FORM_DESIGN, MAX_FORM_RADIUS, type FormDesign } from "@/lib/form-design";
import type { FormField, FormInstall, SignupForm } from "@/lib/types";

// Accent swatches deliberately exclude "transparent" — an invisible button helps no one.
const ACCENT_SWATCHES = [
  "#111827", "#1a1a1a", "#2563eb", "#7c3aed", "#db2777", "#16a34a",
  "#ea580c", "#0891b2", "#4f46e5", "#e11d48",
];

// How long the form must sit unchanged before we autosave it. Short, so saving
// feels near-instant — there's no manual Save button (matches the campaign composer).
const AUTOSAVE_DELAY_MS = 800;

type AutosaveStatus = "idle" | "pending" | "saving" | "saved" | "error";

// The "this saves itself" indicator. With no Save button, this is how the user
// knows their work is safe. "pending" (waiting out the debounce) and "saving"
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

function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setCopied(true);
          toast.success("Copied to clipboard");
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast.error("Couldn't copy — select and copy manually");
        }
      }}
    >
      {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
      {label}
    </Button>
  );
}

function Snippet({ code }: { code: string }) {
  return (
    <pre className="max-h-64 overflow-auto rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed">
      <code>{code}</code>
    </pre>
  );
}

// ── Inspector model ──────────────────────────────────────────────────────────
// The builder is organized as one focused panel at a time (Apple System Settings
// style): a section rail navigates between Design / Fields / Behavior / Share so
// the user only ever sees one concern, with the live preview always beside them.

const SECTIONS = [
  { id: "design", label: "Design", icon: Palette, blurb: "What subscribers see" },
  { id: "fields", label: "Fields", icon: ListChecks, blurb: "What you collect" },
  { id: "behavior", label: "Behavior", icon: SlidersHorizontal, blurb: "Opt-in & after-signup" },
  { id: "share", label: "Share & install", icon: Share2, blurb: "Put it on your site" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

function SectionNav({
  active,
  onSelect,
}: {
  active: SectionId;
  onSelect: (id: SectionId) => void;
}) {
  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 sm:mx-0 sm:flex-col sm:overflow-visible sm:px-0 sm:pb-0">
      {SECTIONS.map((s) => {
        const Icon = s.icon;
        const isActive = s.id === active;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => onSelect(s.id)}
            data-active={isActive}
            className={cn(
              "flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors",
              "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
              "data-[active=true]:bg-muted data-[active=true]:text-foreground",
            )}
          >
            <Icon className="size-4 shrink-0" />
            <span className="whitespace-nowrap">{s.label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// A small uppercase caption that divides a panel into labeled groups.
function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="text-xs font-medium tracking-wide text-muted-foreground/70 uppercase">
      {children}
    </p>
  );
}

// Progressive disclosure for optional/advanced settings — collapsed by default so
// the common path stays uncluttered. Native <details> keeps it keyboard-friendly.
function Disclosure({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <details className="group rounded-lg border border-border/70">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors group-open:text-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        {title}
        <ChevronDown className="size-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 px-3 pb-4 pt-1">{children}</div>
    </details>
  );
}

// A bordered, tappable toggle row — clearer division than a bare checkbox.
function ToggleRow({
  checked,
  onChange,
  title,
  description,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  title: string;
  description: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-border/70 p-3 transition-colors hover:bg-muted/30">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="min-w-0">
        <span className="block text-sm font-medium">{title}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
    </label>
  );
}

// The form's banner image: an upload dropzone when empty, or a preview with
// replace/remove plus an alt-text field. Uploads reuse the shared campaign-assets
// endpoint (account-scoped public bucket) and are downscaled first, same as the
// campaign image sections.
function FormImageField({
  url,
  alt,
  onChange,
  onAltChange,
  upload,
}: {
  url: string | null;
  alt: string;
  onChange: (url: string | null) => void;
  onAltChange: (alt: string) => void;
  upload: (file: File) => Promise<string>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  async function pick(file: File | null | undefined) {
    if (!file) return;
    setBusy(true);
    try {
      // Downscale/re-encode oversized photos before upload; fall back to the original
      // if optimization fails so an upload is never blocked by it.
      const prepared = await compressImageForEmail(file).catch(() => file);
      onChange(await upload(prepared));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't upload that image");
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  return (
    <div className="space-y-2">
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => void pick(e.target.files?.[0])}
      />
      {url ? (
        <div className="space-y-2.5">
          <div className="overflow-hidden rounded-lg border border-border">
            {/* Plain <img> (not next/image): an arbitrary uploaded URL, editor preview only. */}
            <img src={url} alt={alt} className="max-h-32 w-full object-cover" />
          </div>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <ImagePlus className="size-4" />}
              Replace
            </Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
              <Trash2 className="size-4" />
              Remove
            </Button>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="form-image-alt">Image description</Label>
            <Input
              id="form-image-alt"
              value={alt}
              placeholder="Describe the image"
              onChange={(e) => onAltChange(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Shown if the image can&apos;t load, and read aloud by screen readers.
            </p>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="flex w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border/80 px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-border hover:bg-muted/40 disabled:opacity-60"
        >
          {busy ? <Loader2 className="size-5 animate-spin" /> : <ImagePlus className="size-5" />}
          {busy ? "Uploading…" : "Add a banner image"}
        </button>
      )}
    </div>
  );
}

export default function FormDetailPage() {
  const api = useApi();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const [form, setForm] = useState<SignupForm | null>(null);
  const [install, setInstall] = useState<FormInstall | null>(null);
  const [hasVerifiedDomain, setHasVerifiedDomain] = useState(true);
  const [companyName, setCompanyName] = useState("this sender");
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus>("idle");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [section, setSection] = useState<SectionId>("design");

  // The latest form is mirrored into a ref so the debounced save reads current
  // values without being re-created on every keystroke.
  const formRef = useRef<SignupForm | null>(form);
  useEffect(() => {
    formRef.current = form;
  }, [form]);
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // True when there are edits not yet persisted — gates the flush-on-unmount.
  const autosaveDirty = useRef(false);

  const load = useCallback(() => {
    api
      .get<{
        form: SignupForm;
        install: FormInstall;
        hasVerifiedDomain: boolean;
        companyName: string;
      }>(`/api/forms/${id}`)
      .then((res) => {
        setForm(res.form);
        setInstall(res.install);
        setHasVerifiedDomain(res.hasVerifiedDomain);
        setCompanyName(res.companyName);
      })
      .catch((err) => toast.error(err.message));
  }, [api, id]);

  useEffect(load, [load]);

  // Quietly refresh the install assets after an autosave — the slug may have been
  // normalized server-side, which changes the share/embed URLs. Only `install`
  // (and the domain/company hints) are updated; `form` is left untouched so an
  // in-flight save never clobbers keystrokes typed while it was saving.
  const refreshInstall = useCallback(() => {
    api
      .get<{ install: FormInstall; hasVerifiedDomain: boolean; companyName: string }>(
        `/api/forms/${id}`,
      )
      .then((res) => {
        setInstall(res.install);
        setHasVerifiedDomain(res.hasVerifiedDomain);
        setCompanyName(res.companyName);
      })
      .catch(() => {});
  }, [api, id]);

  // The actual persist. Held in a ref so the debounce timer and the unmount flush
  // always call the latest version without re-subscribing. Kept fresh each render
  // by an effect (rather than written during render). Saves quietly: no toast, no
  // navigation — just the inline status indicator.
  const saveRef = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    saveRef.current = async () => {
      const f = formRef.current;
      if (!f) return;
      autosaveDirty.current = false;
      setAutosaveStatus("saving");
      try {
        await api.patch<{ form: SignupForm }>(`/api/forms/${id}`, {
          name: f.name,
          slug: f.slug,
          status: f.status,
          doubleOptIn: f.doubleOptIn,
          fields: f.fields,
          headline: f.headline ?? "",
          description: f.description ?? "",
          footerText: f.footerText ?? "",
          buttonLabel: f.buttonLabel,
          successMessage: f.successMessage ?? "",
          redirectUrl: f.redirectUrl ?? "",
          accentColor: f.accentColor ?? "",
          design: f.design,
        });
        setAutosaveStatus("saved");
        refreshInstall();
      } catch {
        // Keep the edit pending so the next change (or unmount) retries it; the
        // indicator reassures the user their changes are still here.
        autosaveDirty.current = true;
        setAutosaveStatus("error");
      }
    };
  });

  // Debounce a save a beat after each edit — the only save mechanism, so there's
  // no Save button.
  function scheduleAutosave() {
    autosaveDirty.current = true;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    setAutosaveStatus((s) => (s === "saving" ? s : "pending"));
    autosaveTimer.current = setTimeout(() => void saveRef.current(), AUTOSAVE_DELAY_MS);
  }

  // Flush any pending edit on unmount so navigating away mid-edit never drops a
  // change. Fire-and-forget — the component is leaving, so we can't await.
  useEffect(() => {
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      if (autosaveDirty.current) void saveRef.current();
    };
  }, []);

  function patch(changes: Partial<SignupForm>) {
    setForm((f) => (f ? { ...f, ...changes } : f));
    scheduleAutosave();
  }

  // Merge a change into the nested design object and schedule a save.
  function patchDesign(changes: Partial<FormDesign>) {
    setForm((f) => (f ? { ...f, design: { ...f.design, ...changes } } : f));
    scheduleAutosave();
  }

  // Uploads a banner image to the shared asset bucket and returns its public URL.
  async function uploadImage(file: File): Promise<string> {
    const fd = new FormData();
    fd.append("file", file);
    const res = await api.upload<{ url: string }>("/api/campaigns/assets", fd);
    return res.url;
  }

  async function remove() {
    setDeleting(true);
    try {
      await api.del(`/api/forms/${id}`);
      toast.success("Form deleted");
      router.push("/forms");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete form");
      setDeleting(false);
    }
  }

  if (!form || !install) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const activeMeta = SECTIONS.find((s) => s.id === section)!;
  const shareUrl = install.prettyUrl ?? install.hostedUrl;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.push("/forms")}>
            <ArrowLeft className="size-4" />
          </Button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate font-display text-2xl sm:text-3xl">{form.name}</h1>
              {form.status !== "active" && <Badge variant="secondary">Inactive</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">
              {form.submitCount} signups · {form.confirmedCount} confirmed
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          <AutosaveIndicator status={autosaveStatus} />
          <Button
            variant="outline"
            size="sm"
            render={<a href={install.hostedUrl} target="_blank" rel="noreferrer" />}
          >
            <ExternalLink className="size-4" /> Open
          </Button>
          <RowActions>
            <MenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
              <Trash2 />
              Delete
            </MenuItem>
          </RowActions>
        </div>
      </div>

      {form.doubleOptIn && !hasVerifiedDomain && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-400">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
          <span>
            This form requires email confirmation, but you don&apos;t have a verified sending domain
            yet — confirmation emails can&apos;t be sent, so signups will stay unconfirmed.{" "}
            <a href="/domains" className="font-medium underline">
              Verify a domain
            </a>{" "}
            to enable double opt-in.
          </span>
        </div>
      )}

      {/* Inspector (rail + focused panel) on the left, sticky live canvas on the right. */}
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(340px,400px)] lg:items-start">
        <div className="grid gap-5 sm:grid-cols-[150px_minmax(0,1fr)] sm:items-start">
          <SectionNav active={section} onSelect={setSection} />

          <Card>
            <CardHeader>
              <CardTitle>{activeMeta.label}</CardTitle>
              <p className="text-sm text-muted-foreground">{activeMeta.blurb}</p>
            </CardHeader>
            <CardContent>
              {section === "design" && (
                <div className="space-y-5">
                  <div className="space-y-1.5">
                    <Label htmlFor="name">Form name</Label>
                    <Input
                      id="name"
                      value={form.name}
                      onChange={(e) => patch({ name: e.target.value })}
                    />
                    <p className="text-xs text-muted-foreground">
                      Only you see this — it labels the form in your dashboard.
                    </p>
                  </div>

                  <Separator />

                  <GroupLabel>Content</GroupLabel>
                  <div className="space-y-1.5">
                    <Label htmlFor="headline">Headline</Label>
                    <Input
                      id="headline"
                      placeholder="Subscribe"
                      value={form.headline ?? ""}
                      onChange={(e) => patch({ headline: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="description">Description</Label>
                    <Textarea
                      id="description"
                      rows={2}
                      placeholder="A short line about what subscribers get."
                      value={form.description ?? ""}
                      onChange={(e) => patch({ description: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="footerText">Footer text</Label>
                    <Textarea
                      id="footerText"
                      rows={2}
                      placeholder="Optional — a note below the form (privacy line, what to expect…)."
                      value={form.footerText ?? ""}
                      onChange={(e) => patch({ footerText: e.target.value })}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="buttonLabel">Button label</Label>
                    <Input
                      id="buttonLabel"
                      value={form.buttonLabel}
                      onChange={(e) => patch({ buttonLabel: e.target.value })}
                    />
                  </div>

                  <Separator />

                  <div className="flex items-center justify-between">
                    <GroupLabel>Appearance</GroupLabel>
                    <button
                      type="button"
                      onClick={() => {
                        patch({ accentColor: "#111827" });
                        patchDesign({ ...DEFAULT_FORM_DESIGN });
                      }}
                      className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <RotateCcw className="size-3" />
                      Reset
                    </button>
                  </div>

                  <div className="space-y-1.5">
                    <Label>Banner image</Label>
                    <FormImageField
                      url={form.design.imageUrl}
                      alt={form.design.imageAlt}
                      onChange={(imageUrl) => patchDesign({ imageUrl })}
                      onAltChange={(imageAlt) => patchDesign({ imageAlt })}
                      upload={uploadImage}
                    />
                  </div>

                  <div className="space-y-3 rounded-lg border border-border/70 p-3">
                    <ColorField
                      label="Page background"
                      value={form.design.pageBg}
                      onChange={(c) => patchDesign({ pageBg: c })}
                    />
                    <ColorField
                      label="Card background"
                      value={form.design.cardBg}
                      onChange={(c) => patchDesign({ cardBg: c })}
                    />
                    <ColorField
                      label="Heading"
                      value={form.design.headingColor}
                      onChange={(c) => patchDesign({ headingColor: c })}
                    />
                    <ColorField
                      label="Text"
                      value={form.design.textColor}
                      onChange={(c) => patchDesign({ textColor: c })}
                    />
                    <ColorField
                      label="Button"
                      value={form.accentColor || "#111827"}
                      onChange={(c) => patch({ accentColor: c })}
                      swatches={ACCENT_SWATCHES}
                    />
                    <SliderField
                      label="Corner roundness"
                      value={form.design.cornerRadius}
                      onChange={(v) => patchDesign({ cornerRadius: v })}
                      max={MAX_FORM_RADIUS}
                    />
                  </div>
                </div>
              )}

              {section === "fields" && (
                <div className="space-y-4">
                  <p className="text-sm text-muted-foreground">
                    Collect more than an email — add any fields you want. Each one becomes a
                    personalization tag you can use in campaigns.
                  </p>
                  <FormFieldsEditor
                    fields={form.fields}
                    onChange={(fields: FormField[]) => patch({ fields })}
                  />
                </div>
              )}

              {section === "behavior" && (
                <div className="space-y-4">
                  <ToggleRow
                    checked={form.doubleOptIn}
                    onChange={(v) => patch({ doubleOptIn: v })}
                    title="Require email confirmation (double opt-in)"
                    description="Subscribers confirm via email before they're mailable. Strongly recommended."
                  />
                  <ToggleRow
                    checked={form.status === "active"}
                    onChange={(v) => patch({ status: v ? "active" : "disabled" })}
                    title="Form is active"
                    description="Turn off to stop accepting signups without deleting the form."
                  />

                  <Disclosure title="After signup & advanced">
                    <div className="space-y-1.5">
                      <Label htmlFor="success">Success message</Label>
                      <Input
                        id="success"
                        placeholder="Default: a friendly confirmation message"
                        value={form.successMessage ?? ""}
                        onChange={(e) => patch({ successMessage: e.target.value })}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="redirect">Redirect URL (optional)</Label>
                      <Input
                        id="redirect"
                        placeholder="https://yoursite.com/thanks"
                        value={form.redirectUrl ?? ""}
                        onChange={(e) => patch({ redirectUrl: e.target.value })}
                      />
                      <p className="text-xs text-muted-foreground">
                        Send people here after signup instead of our hosted thank-you page.
                      </p>
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="slug">Share URL slug</Label>
                      <Input
                        id="slug"
                        value={form.slug}
                        onChange={(e) => patch({ slug: e.target.value })}
                      />
                      <p className="text-xs text-muted-foreground">
                        Used in your pretty share link. Embeds use the stable link, so renaming is
                        safe.
                      </p>
                    </div>
                  </Disclosure>
                </div>
              )}

              {section === "share" && (
                <Tabs defaultValue="share">
                  <TabsList>
                    <TabsTrigger value="share">Share link</TabsTrigger>
                    <TabsTrigger value="embed">Embed</TabsTrigger>
                    <TabsTrigger value="popup">Popup</TabsTrigger>
                    <TabsTrigger value="html">HTML</TabsTrigger>
                    <TabsTrigger value="ai">
                      <Sparkles className="size-3.5" />
                      AI prompt
                    </TabsTrigger>
                  </TabsList>

                  <TabsContent value="share" className="space-y-3 pt-4">
                    <p className="text-sm text-muted-foreground">
                      Zero setup — paste this link in your bio, emails, or social. Works everywhere.
                    </p>
                    <div className="flex items-center gap-2">
                      <Input readOnly value={shareUrl} />
                      <CopyButton value={shareUrl} />
                    </div>
                    {install.prettyUrl && (
                      <p className="text-xs text-muted-foreground">
                        Stable link (for QR codes etc.):{" "}
                        <span className="break-all">{install.hostedUrl}</span>
                      </p>
                    )}
                  </TabsContent>

                  <TabsContent value="embed" className="space-y-3 pt-4">
                    <p className="text-sm text-muted-foreground">
                      Recommended. Paste into any website builder&apos;s embed/HTML block (Webflow,
                      WordPress, Squarespace, Wix, Framer…). Auto-resizes to fit.
                    </p>
                    <Snippet code={install.iframeSnippet} />
                    <CopyButton value={install.iframeSnippet} label="Copy embed code" />
                  </TabsContent>

                  <TabsContent value="popup" className="space-y-3 pt-4">
                    <p className="text-sm text-muted-foreground">
                      A button that opens the form in a modal — or trigger it automatically on exit
                      intent, a delay, or scroll depth. Needs JavaScript on the page.
                    </p>
                    <Snippet code={install.popupSnippet} />
                    <CopyButton value={install.popupSnippet} label="Copy popup code" />
                  </TabsContent>

                  <TabsContent value="html" className="space-y-3 pt-4">
                    <p className="text-sm text-muted-foreground">
                      Full control. A native form that posts straight to Day3 — no JavaScript
                      required.
                    </p>
                    <Snippet code={install.htmlSnippet} />
                    <CopyButton value={install.htmlSnippet} label="Copy HTML" />
                  </TabsContent>

                  <TabsContent value="ai" className="space-y-3 pt-4">
                    <p className="text-sm text-muted-foreground">
                      No code, no copy-paste juggling. Copy this prompt, paste it into your AI
                      assistant (ChatGPT, Claude, Cursor, Copilot…), and it&apos;ll walk you through
                      putting the form on your site.
                    </p>
                    <Snippet code={install.aiPrompt} />
                    <CopyButton value={install.aiPrompt} label="Copy AI prompt" />
                  </TabsContent>
                </Tabs>
              )}
            </CardContent>
          </Card>
        </div>

        {/* ── Sticky live canvas ─────────────────────────────────── */}
        <div className="lg:sticky lg:top-6">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-medium">Preview</span>
            <span className="text-xs text-muted-foreground">Updates as you type</span>
          </div>
          <div className="overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
            {/* Faux browser chrome ties the preview to the real share link. */}
            <div className="flex items-center gap-2 border-b border-border/60 bg-muted/40 px-3 py-2">
              <span aria-hidden className="flex gap-1.5">
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="size-2.5 rounded-full bg-foreground/15" />
                <span className="size-2.5 rounded-full bg-foreground/15" />
              </span>
              <span className="truncate rounded-md bg-background px-2 py-1 text-xs text-muted-foreground">
                {shareUrl}
              </span>
            </div>
            {/* Live, non-interactive render of the real public form component,
                driven by the unsaved client state so it updates as you type. */}
            <div
              aria-hidden
              className="pointer-events-none max-h-[640px] select-none overflow-auto bg-[#f6f7f9]"
            >
              <PublicFormView form={form} companyName={companyName} embed />
            </div>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={`Delete "${form.name}"?`}
        description="This permanently deletes the form and its hosted page and embed. Subscribers already collected stay in their audience. This can't be undone."
        confirmLabel="Delete form"
        busy={deleting}
        onConfirm={remove}
      />
    </div>
  );
}
