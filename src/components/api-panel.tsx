"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowUpRight, Code2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton } from "@/components/copy-button";
import { CopyLine, Snippet } from "@/components/api-snippet";
import { ApiError, useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { apiBaseUrl, type ApiPanelContent } from "@/lib/api-docs";

// The </> button on resource pages — a Resend-style slide-out with everything a
// developer needs to work with the resource in view: its real ids, the base
// URL, key status, snippets, and an AI context pack. Content is built in
// src/lib/api-docs.ts from state the page already holds; the only network call
// is the lazy key-status check on first open.

type KeyState =
  | { status: "idle" | "loading" | "error" }
  // Members get a 403 from /api/api-keys — keys are org-admin territory.
  | { status: "admin_only" }
  | { status: "known"; active: number };

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
      {children}
    </h3>
  );
}

export function ApiPanel({
  build,
  label = "Use the API",
  className,
}: {
  /** Builds the panel content once the browser origin is known. */
  build: (origin: string) => ApiPanelContent;
  /** Tooltip / accessible name on the trigger button. */
  label?: string;
  /** Extra classes for the trigger button. */
  className?: string;
}) {
  const api = useApi();
  const [open, setOpen] = useState(false);
  // The API is served from the same origin as the app — the browser is the
  // authoritative source for the base URL (same reasoning as /api-keys).
  const [origin, setOrigin] = useState("");
  const [keys, setKeys] = useState<KeyState>({ status: "idle" });
  const [lang, setLang] = useState("curl");

  useEffect(() => setOrigin(window.location.origin), []);

  // Key status is the one thing the host page doesn't know — fetched once, on
  // first open, so pages that never open the panel never pay for it.
  useEffect(() => {
    if (!open || keys.status !== "idle") return;
    setKeys({ status: "loading" });
    api
      .get<{ keys: { revokedAt: string | null }[] }>("/api/api-keys")
      .then((res) =>
        setKeys({ status: "known", active: res.keys.filter((k) => !k.revokedAt).length }),
      )
      .catch((err) =>
        setKeys(
          err instanceof ApiError && err.status === 403
            ? { status: "admin_only" }
            : { status: "error" },
        ),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, keys.status]);

  const content = origin ? build(origin) : null;

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={label}
            title={label}
            // The trigger sits beside a text-2xl page title. Box-centering puts
            // it ~1px above the title's optical centre (cap-height sits low in
            // the line box), so nudge it down to line up with the letterforms.
            className={cn("translate-y-[3px] text-muted-foreground", className)}
          >
            <Code2 />
          </Button>
        }
      />
      <SheetContent side="right" className="gap-0 overflow-y-auto p-4 sm:max-w-lg sm:p-6">
        {content && (
          <div className="space-y-6">
            <SheetHeader className="p-0 pr-8">
              <SheetTitle>Use the API</SheetTitle>
              <SheetDescription>{content.blurb}</SheetDescription>
            </SheetHeader>

            {/* ── Base URL + key status ─────────────────────────────── */}
            <section className="space-y-2">
              <SectionTitle>Base URL</SectionTitle>
              <CopyLine value={apiBaseUrl(origin)} />
              {keys.status === "known" && keys.active === 0 && (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="text-sm font-medium">No API key yet</p>
                    <p className="text-xs text-muted-foreground">
                      Create one to authenticate — it takes a few seconds.
                    </p>
                  </div>
                  <Button size="sm" render={<Link href="/api-keys" />}>
                    Create key
                  </Button>
                </div>
              )}
              {keys.status === "known" && keys.active > 0 && (
                <p className="text-xs text-muted-foreground">
                  Authenticated with{" "}
                  <code className="font-mono">Authorization: Bearer day3_live_…</code> — you have{" "}
                  {keys.active} active key{keys.active === 1 ? "" : "s"}.{" "}
                  <Link href="/api-keys" className="underline underline-offset-2 hover:text-foreground">
                    Manage keys
                  </Link>
                </p>
              )}
              {keys.status === "admin_only" && (
                <p className="text-xs text-muted-foreground">
                  Authenticated with{" "}
                  <code className="font-mono">Authorization: Bearer day3_live_…</code>. API keys
                  are created by organization admins — ask yours for one.
                </p>
              )}
            </section>

            {/* ── Ids in view ───────────────────────────────────────── */}
            {content.idGroups.map((group) => (
              <section key={group.title} className="space-y-2">
                <SectionTitle>{group.title}</SectionTitle>
                <div className="divide-y rounded-lg border">
                  {group.rows.map((row) => (
                    <div key={row.value} className="flex items-center gap-2 px-3 py-1.5">
                      <span
                        className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
                        title={row.label}
                      >
                        {row.label}
                      </span>
                      <code className="max-w-28 truncate font-mono text-xs sm:max-w-52">
                        {row.value}
                      </code>
                      <CopyButton value={row.value} title={`Copy ${row.label}`} />
                    </div>
                  ))}
                </div>
              </section>
            ))}

            {content.note && <p className="text-xs text-muted-foreground">{content.note}</p>}

            {/* ── Snippets ──────────────────────────────────────────── */}
            {content.tasks.length > 0 && (
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <SectionTitle>Snippets</SectionTitle>
                  <Tabs value={lang} onValueChange={(v) => setLang(v as string)}>
                    <TabsList>
                      <TabsTrigger value="curl">cURL</TabsTrigger>
                      <TabsTrigger value="js">JavaScript</TabsTrigger>
                      <TabsTrigger value="python">Python</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
                {/* Keyed so switching resource tabs while closed can't leave the
                    task selector pointing at a task that no longer exists. */}
                <Tabs
                  key={content.tasks.map((t) => t.id).join()}
                  defaultValue={content.tasks[0].id}
                >
                  <TabsList variant="line">
                    {content.tasks.map((t) => (
                      <TabsTrigger key={t.id} value={t.id}>
                        {t.label}
                      </TabsTrigger>
                    ))}
                  </TabsList>
                  {content.tasks.map((t) => {
                    const code = t[lang as "curl" | "js" | "python"];
                    return (
                      <TabsContent key={t.id} value={t.id} className="space-y-2 pt-3">
                        <p className="text-xs text-muted-foreground">{t.blurb}</p>
                        <Snippet code={code} />
                        <CopyButton value={code} label="Copy" variant="outline" />
                      </TabsContent>
                    );
                  })}
                </Tabs>
              </section>
            )}

            {/* ── AI context pack ───────────────────────────────────── */}
            {content.prompt && (
              <section className="space-y-2 rounded-lg border border-border p-3">
                <div className="flex items-center gap-2">
                  <Sparkles className="size-4 text-muted-foreground" />
                  <p className="text-sm font-medium">Building with AI?</p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Copy a context pack — the ids above plus the full API reference — and paste it
                  into Claude, Cursor, ChatGPT or Copilot before whatever you ask it to build. It
                  writes working Day3 code without asking you for ids.
                </p>
                <CopyButton value={content.prompt} label="Copy AI context" variant="outline" />
              </section>
            )}

            <div className="border-t border-border pt-4">
              <Link
                href="/api-keys"
                className="inline-flex items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
              >
                Full API docs, quickstart &amp; keys
                <ArrowUpRight className="size-3.5" />
              </Link>
            </div>
          </div>
        )}
      </SheetContent>
    </Sheet>
  );
}
