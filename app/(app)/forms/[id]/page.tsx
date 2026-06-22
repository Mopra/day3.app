"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { AlertTriangle, ArrowLeft, Check, Copy, ExternalLink, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi } from "@/lib/api";
import type { FormInstall, SignupForm } from "@/lib/types";

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

export default function FormDetailPage() {
  const api = useApi();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();

  const [form, setForm] = useState<SignupForm | null>(null);
  const [install, setInstall] = useState<FormInstall | null>(null);
  const [hasVerifiedDomain, setHasVerifiedDomain] = useState(true);
  const [saving, setSaving] = useState(false);
  const [previewKey, setPreviewKey] = useState(0);

  const load = useCallback(() => {
    api
      .get<{ form: SignupForm; install: FormInstall; hasVerifiedDomain: boolean }>(`/api/forms/${id}`)
      .then((res) => {
        setForm(res.form);
        setInstall(res.install);
        setHasVerifiedDomain(res.hasVerifiedDomain);
      })
      .catch((err) => toast.error(err.message));
  }, [api, id]);

  useEffect(load, [load]);

  function patch(changes: Partial<SignupForm>) {
    setForm((f) => (f ? { ...f, ...changes } : f));
  }

  async function save() {
    if (!form) return;
    setSaving(true);
    try {
      const res = await api.patch<{ form: SignupForm }>(`/api/forms/${id}`, {
        name: form.name,
        slug: form.slug,
        status: form.status,
        doubleOptIn: form.doubleOptIn,
        collectName: form.collectName,
        headline: form.headline ?? "",
        description: form.description ?? "",
        buttonLabel: form.buttonLabel,
        successMessage: form.successMessage ?? "",
        redirectUrl: form.redirectUrl ?? "",
        accentColor: form.accentColor ?? "",
      });
      setForm(res.form);
      setPreviewKey((k) => k + 1);
      // Slug may have been normalized → refresh install URLs.
      load();
      toast.success("Saved");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm("Delete this form? Embeds and links using it will stop working.")) return;
    try {
      await api.del(`/api/forms/${id}`);
      toast.success("Form deleted");
      router.push("/forms");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete");
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

  const previewUrl = `${install.hostedUrl}?embed=1`;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" onClick={() => router.push("/forms")}>
            <ArrowLeft className="size-4" />
          </Button>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{form.name}</h1>
            <p className="text-sm text-muted-foreground">
              {form.submitCount} signups · {form.confirmedCount} confirmed
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            render={<a href={install.hostedUrl} target="_blank" rel="noreferrer" />}
          >
            <ExternalLink className="size-4" /> Open
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <OrbitLoader size={16} />}
            Save changes
          </Button>
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

      <div className="grid gap-6 lg:grid-cols-2">
        {/* ── Settings ───────────────────────────────────────────── */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Content</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Form name</Label>
                <Input id="name" value={form.name} onChange={(e) => patch({ name: e.target.value })} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="headline">Headline</Label>
                <Input
                  id="headline"
                  placeholder={`Subscribe`}
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
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="buttonLabel">Button label</Label>
                  <Input
                    id="buttonLabel"
                    value={form.buttonLabel}
                    onChange={(e) => patch({ buttonLabel: e.target.value })}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="accent">Accent color</Label>
                  <div className="flex items-center gap-2">
                    <input
                      id="accent"
                      type="color"
                      className="h-9 w-12 cursor-pointer rounded-md border border-input bg-transparent"
                      value={form.accentColor || "#111827"}
                      onChange={(e) => patch({ accentColor: e.target.value })}
                    />
                    <Input
                      value={form.accentColor ?? ""}
                      placeholder="#111827"
                      onChange={(e) => patch({ accentColor: e.target.value })}
                    />
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Behavior</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={form.doubleOptIn}
                  onChange={(e) => patch({ doubleOptIn: e.target.checked })}
                />
                <span>
                  <span className="font-medium">Require email confirmation (double opt-in)</span>
                  <span className="block text-xs text-muted-foreground">
                    Subscribers confirm via email before they&apos;re mailable. Strongly recommended.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={form.collectName}
                  onChange={(e) => patch({ collectName: e.target.checked })}
                />
                <span>
                  <span className="font-medium">Collect first name</span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={form.status === "active"}
                  onChange={(e) => patch({ status: e.target.checked ? "active" : "disabled" })}
                />
                <span>
                  <span className="font-medium">Form is active</span>
                  <span className="block text-xs text-muted-foreground">
                    Turn off to stop accepting signups without deleting the form.
                  </span>
                </span>
              </label>
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
                <Input id="slug" value={form.slug} onChange={(e) => patch({ slug: e.target.value })} />
                <p className="text-xs text-muted-foreground">
                  Used in your pretty share link. Embeds use the stable link, so renaming is safe.
                </p>
              </div>
            </CardContent>
          </Card>

          <Button variant="ghost" size="sm" onClick={remove} className="text-destructive">
            <Trash2 className="size-4" /> Delete form
          </Button>
        </div>

        {/* ── Install + preview ──────────────────────────────────── */}
        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Install</CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue="share">
                <TabsList>
                  <TabsTrigger value="share">Share link</TabsTrigger>
                  <TabsTrigger value="embed">Embed</TabsTrigger>
                  <TabsTrigger value="popup">Popup</TabsTrigger>
                  <TabsTrigger value="html">HTML</TabsTrigger>
                </TabsList>

                <TabsContent value="share" className="space-y-3 pt-4">
                  <p className="text-sm text-muted-foreground">
                    Zero setup — paste this link in your bio, emails, or social. Works everywhere.
                  </p>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={install.prettyUrl ?? install.hostedUrl} />
                    <CopyButton value={install.prettyUrl ?? install.hostedUrl} />
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
                    Full control. A native form that posts straight to Day3 — no JavaScript required.
                  </p>
                  <Snippet code={install.htmlSnippet} />
                  <CopyButton value={install.htmlSnippet} label="Copy HTML" />
                </TabsContent>
              </Tabs>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Preview</CardTitle>
            </CardHeader>
            <CardContent>
              <iframe
                key={previewKey}
                src={previewUrl}
                title="Form preview"
                className="w-full rounded-lg border border-border bg-white"
                style={{ height: 460 }}
              />
              <p className="mt-2 text-xs text-muted-foreground">Preview reflects saved changes.</p>
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
