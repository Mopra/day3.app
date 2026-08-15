"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Plug, Sparkles, Terminal, TriangleAlert } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CopyButton } from "@/components/copy-button";
import { CopyLine, Snippet } from "@/components/api-snippet";
import { useApi } from "@/lib/api";
import {
  apiBaseUrl,
  buildAgentPrompts,
  buildMcpSetups,
  buildReferenceMarkdown,
  buildSnippetTasks,
  exportKeyLine,
  verifyCurl,
  PLACEHOLDER_AUDIENCE,
  type ApiDocsContext,
  type SubscriberLimit,
} from "@/lib/api-docs";
import { MARKDOWN_DIALECT_REFERENCE } from "@/lib/campaign-markdown-docs";

// Everything below the key list on /api-keys: a quickstart wired to the user's
// real audience id, copy-paste prompts for an AI assistant, per-language
// snippets, and the endpoint map. Content lives in src/lib/api-docs.ts; this
// file is the renderer.
//
// `freshKey` is the key the user just minted, held in memory by the page. It is
// substituted into the `export DAY3_API_KEY=…` line only — never into a snippet
// and never into an AI prompt, since those get pasted into third-party tools.

type AudienceOption = { id: string; name: string };

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      {/* size-5 == text-sm's 20px line box, so the badge and the step title
          share a top edge with no nudge. */}
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-medium tabular-nums text-muted-foreground">
        {n}
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="text-sm font-medium">{title}</p>
        {children}
      </div>
    </div>
  );
}

const ENDPOINT_GROUPS: Array<{ title: string; note: string; rows: [string, string][] }> = [
  {
    title: "Audiences",
    note: "A list of contacts. Everything else lives inside one.",
    rows: [
      ["GET /audiences", "List every audience"],
      ["POST /audiences", "Create one"],
      ["GET /audiences/{id}", "One audience, with contact counts"],
      ["PATCH /audiences/{id}", "Rename"],
      ["DELETE /audiences/{id}", "Delete it and everything in it"],
    ],
  },
  {
    title: "Contacts",
    note: "Addressable by id or by plain URL-encoded email — no lookup round-trip.",
    rows: [
      ["GET /audiences/{aud}/contacts", "List; filter by status, email or segment_id"],
      ["POST /audiences/{aud}/contacts", "Create — add ?upsert=true to update instead of conflict"],
      ["POST /audiences/{aud}/contacts/batch", "Up to 1,000 per call, per-row results"],
      ["GET /audiences/{aud}/contacts/{id|email}", "One contact — ?expand=topics for its topic map"],
      ["PATCH /audiences/{aud}/contacts/{id|email}", "Update fields, attributes or status"],
      ["DELETE /audiences/{aud}/contacts/{id|email}", "Erase (GDPR) — unsubscribe instead to keep the record"],
      ["GET|PATCH /audiences/{aud}/contacts/{id|email}/topics", "Per-topic subscription state"],
    ],
  },
  {
    title: "Fields",
    note: "Custom attribute keys. They auto-register when contacts arrive with new ones.",
    rows: [
      ["GET|POST /audiences/{aud}/fields", "List or declare a field"],
      ["GET|PATCH|DELETE /audiences/{aud}/fields/{id|key}", "By id or key — key itself is immutable"],
    ],
  },
  {
    title: "Segments",
    note: "Saved filters, evaluated live — membership is never materialized.",
    rows: [
      ["GET|POST /audiences/{aud}/segments", "List or create"],
      ["GET|PATCH|DELETE /audiences/{aud}/segments/{id}", "Read, edit or remove"],
      ["GET /audiences/{aud}/segments/{id}/contacts", "Who matches right now"],
    ],
  },
  {
    title: "Topics",
    note: "Subscription categories a contact can opt out of individually.",
    rows: [
      ["GET|POST /audiences/{aud}/topics", "List or create"],
      ["GET|PATCH|DELETE /audiences/{aud}/topics/{id}", "Read, edit or remove"],
    ],
  },
  {
    title: "Campaigns",
    note: "Write a newsletter from your own code — or from an AI editor over MCP.",
    rows: [
      ["GET /campaigns", "List; filter by status"],
      ["POST /campaigns", "Create a draft from markdown, sections or html"],
      ["GET /campaigns/{id}", "One campaign, body included as all three formats"],
      ["PATCH /campaigns/{id}", "Edit a draft — only the fields you send change"],
      ["DELETE /campaigns/{id}", "Delete a draft"],
      ["GET /campaigns/{id}/preview", "The rendered email — ?format=html to view it"],
      ["POST /campaigns/{id}/test", "Send to addresses you name; never the audience"],
      ["POST /campaigns/{id}/send", "Send to the audience — needs the campaigns:send scope"],
      ["POST|DELETE /campaigns/{id}/schedule", "Schedule or un-schedule a send"],
    ],
  },
  {
    title: "Suppressions",
    note: "Account-wide, not per audience. Add-only over the API — un-suppress in the app.",
    rows: [
      ["GET /suppressions", "List your suppressed addresses"],
      ["GET /suppressions/{email}", "200 with the reason, or 404"],
      ["POST /suppressions", "Import bounces and complaints from your old provider"],
    ],
  },
];

export function ApiDocsSection({ freshKey }: { freshKey: string | null }) {
  const api = useApi();
  // The API is served from the same origin as the app, so the browser is the
  // authoritative source for the base URL — no NEXT_PUBLIC_ env var to drift.
  const [origin, setOrigin] = useState("");
  const [audiences, setAudiences] = useState<AudienceOption[]>([]);
  const [audienceId, setAudienceId] = useState<string | null>(null);
  const [limit, setLimit] = useState<SubscriberLimit | null>(null);
  const [lang, setLang] = useState("curl");

  useEffect(() => {
    setOrigin(window.location.origin);
    api
      .get<{ audiences: AudienceOption[] }>("/api/audiences")
      .then((res) => {
        setAudiences(res.audiences);
        setAudienceId(res.audiences[0]?.id ?? null);
      })
      // Examples fall back to a placeholder id — worth showing docs regardless.
      .catch(() => setAudiences([]));
    // A capped plan rejects an oversized import whole, on the first batch. Warn
    // here instead. `cap: null` is an uncapped (paid) plan — nothing to say.
    api
      .get<{ cap: number | null; used: number | null; headroom: number | null }>(
        "/api/account/subscriber-limit",
      )
      .then((res) => {
        if (res.cap !== null && res.used !== null && res.headroom !== null) {
          setLimit({ cap: res.cap, used: res.used, headroom: res.headroom });
        }
      })
      .catch(() => setLimit(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selected = audiences.find((a) => a.id === audienceId) ?? null;

  const ctx: ApiDocsContext = useMemo(
    () => ({
      origin,
      audienceId: selected?.id ?? PLACEHOLDER_AUDIENCE,
      audienceName: selected?.name ?? null,
      subscriberLimit: limit,
    }),
    [origin, selected, limit],
  );

  const tasks = useMemo(() => buildSnippetTasks(ctx), [ctx]);
  const prompts = useMemo(() => buildAgentPrompts(ctx), [ctx]);
  const reference = useMemo(() => buildReferenceMarkdown(ctx), [ctx]);
  const mcpSetups = useMemo(() => buildMcpSetups(ctx, freshKey), [ctx, freshKey]);

  // The origin is only known after mount; rendering snippets against an empty
  // base URL would hand out broken copy targets.
  if (!origin) return null;

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-medium">Using the API</h2>
          <p className="text-sm text-muted-foreground">
            Manage audiences, contacts, custom fields, segments and topics from your own code —
            or move a list over from another provider.
          </p>
        </div>
        {/* Every example below is filled in with a real audience id, so it runs
            as-is. With one audience that's silent; with several, let them pick. */}
        {audiences.length === 1 && (
          <p className="text-xs text-muted-foreground">
            Examples use <span className="font-medium">{audiences[0].name}</span>
          </p>
        )}
        {audiences.length > 1 && (
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">Examples use</span>
            <Select
              items={audiences.map((a) => ({ value: a.id, label: a.name }))}
              value={audienceId}
              onValueChange={(v) => setAudienceId(v as string)}
            >
              <SelectTrigger size="sm" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {audiences.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    {a.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* A capped plan rejects an over-cap import *whole*, on the first batch —
          so the honest place to say so is before the prompts, not in a 403. */}
      {limit && (
        // Neutral while there's room (it's a heads-up), destructive at zero —
        // where no import can succeed at all until the plan changes.
        <Alert variant={limit.headroom === 0 ? "destructive" : "default"}>
          <TriangleAlert />
          <AlertTitle>
            {limit.headroom > 0
              ? `Your plan holds ${limit.headroom.toLocaleString()} more contacts`
              : "Your plan is full"}
          </AlertTitle>
          <AlertDescription>
            <p>
              The Free plan is capped at {limit.cap.toLocaleString()} contacts and you have{" "}
              {limit.used.toLocaleString()}. An import that would take you past the cap is{" "}
              <strong className="font-medium text-foreground">rejected in full</strong> — nothing
              is partially written — so a bigger list needs a paid plan before you start, not
              halfway through.
            </p>
            <p>
              <Link href="/billing" className="underline underline-offset-4">
                Upgrade for unlimited contacts
              </Link>
            </p>
          </AlertDescription>
        </Alert>
      )}

      {/* ── Quickstart ─────────────────────────────────────────────── */}
      <Card>
        <CardContent className="space-y-5">
          <div className="flex items-center gap-2">
            <Terminal className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Quickstart</h3>
            <Badge variant="outline" className="font-normal text-muted-foreground">
              about a minute
            </Badge>
          </div>

          <Step n={1} title="Point your code at the API">
            <CopyLine value={apiBaseUrl(origin)} />
          </Step>

          <Step n={2} title="Put your key in your environment">
            {freshKey ? (
              <p className="text-xs text-muted-foreground">
                Your new key is filled in below. It won&apos;t be shown again after you leave
                this page.
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Create a key above and paste it in — stored keys can never be shown again.
              </p>
            )}
            <CopyLine value={exportKeyLine(freshKey)} muted={!freshKey} />
          </Step>

          <Step n={3} title="Check that it works">
            <Snippet code={verifyCurl(ctx)} />
            <div className="flex items-center gap-3">
              <CopyButton value={verifyCurl(ctx)} label="Copy" variant="outline" />
              <span className="text-xs text-muted-foreground">
                You should get back a JSON list of your audiences.
              </span>
            </div>
          </Step>
        </CardContent>
      </Card>

      {/* ── MCP ────────────────────────────────────────────────────── */}
      <Card>
        <CardContent className="space-y-5">
          <div className="flex items-center gap-2">
            <Plug className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Write emails in your AI editor</h3>
            <Badge variant="outline" className="font-normal text-muted-foreground">
              MCP
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            Connect Day3 to Claude Code, Cursor or VS Code and write campaigns where you already
            work. Drafts show up in Day3 straight away, and you can keep editing them in the
            composer — or hand one back to your assistant to revise.
          </p>

          <Tabs defaultValue={mcpSetups[0].id}>
            <TabsList>
              {mcpSetups.map((s) => (
                <TabsTrigger key={s.id} value={s.id}>
                  {s.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {mcpSetups.map((s) => (
              <TabsContent key={s.id} value={s.id} className="space-y-3 pt-4">
                <p className="text-sm text-muted-foreground">{s.blurb}</p>
                <Snippet code={s.code} />
                <CopyButton value={s.code} label="Copy" variant="outline" />
              </TabsContent>
            ))}
          </Tabs>

          <div className="space-y-2 border-t border-border pt-4">
            <p className="text-sm font-medium">What your assistant can do</p>
            <p className="text-sm text-muted-foreground">
              Read your audiences and senders, write and revise campaign drafts, preview the
              rendered email, and send test emails to addresses you name.{" "}
              <strong className="font-medium text-foreground">
                It cannot email your audience
              </strong>{" "}
              unless you tick “Allow sending campaigns” when creating the key.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <CopyButton
              value={MARKDOWN_DIALECT_REFERENCE}
              label="Copy the markdown reference"
              variant="outline"
            />
            <span className="text-xs text-muted-foreground">
              The email format, for a repo rules file. Over MCP your assistant already has it.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── AI assistant prompts ───────────────────────────────────── */}
      <Card>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <Sparkles className="size-4 text-muted-foreground" />
            <h3 className="text-sm font-medium">Hand it to your AI assistant</h3>
          </div>
          <p className="text-sm text-muted-foreground">
            These prompts carry the whole API reference with them, already filled in with your
            audience id. Copy one, paste it into Claude, ChatGPT, Cursor, Copilot — anything that
            writes code — and it can build against Day3 without looking anything up.
          </p>

          <Tabs defaultValue={prompts[0].id}>
            <TabsList>
              {prompts.map((p) => (
                <TabsTrigger key={p.id} value={p.id}>
                  {p.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {prompts.map((p) => (
              <TabsContent key={p.id} value={p.id} className="space-y-3 pt-4">
                <p className="text-sm text-muted-foreground">{p.blurb}</p>
                <Snippet code={p.text} tall />
                <CopyButton value={p.text} label="Copy prompt" variant="outline" />
              </TabsContent>
            ))}
          </Tabs>

          <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4">
            <CopyButton value={reference} label="Copy the reference on its own" variant="outline" />
            <span className="text-xs text-muted-foreground">
              Markdown — drop it into your repo (AGENTS.md, CLAUDE.md, .cursor/rules) so your
              assistant always has it.
            </span>
          </div>
        </CardContent>
      </Card>

      {/* ── Common tasks ───────────────────────────────────────────── */}
      <Card>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-sm font-medium">Common tasks</h3>
            <Tabs value={lang} onValueChange={(v) => setLang(v as string)}>
              <TabsList>
                <TabsTrigger value="curl">cURL</TabsTrigger>
                <TabsTrigger value="js">JavaScript</TabsTrigger>
                <TabsTrigger value="python">Python</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

          <Tabs defaultValue={tasks[0].id}>
            <TabsList>
              {tasks.map((t) => (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {tasks.map((t) => {
              const code = t[lang as "curl" | "js" | "python"];
              return (
                <TabsContent key={t.id} value={t.id} className="space-y-3 pt-4">
                  <p className="text-sm text-muted-foreground">{t.blurb}</p>
                  <Snippet code={code} />
                  <CopyButton value={code} label="Copy" variant="outline" />
                </TabsContent>
              );
            })}
          </Tabs>
        </CardContent>
      </Card>

      {/* ── Endpoint map ───────────────────────────────────────────── */}
      <Card>
        <CardContent className="space-y-5">
          <div>
            <h3 className="text-sm font-medium">Every endpoint</h3>
            <p className="text-sm text-muted-foreground">
              All paths are relative to{" "}
              <code className="font-mono text-xs">{apiBaseUrl(origin)}</code>. Lists are
              cursor-paginated (<code className="font-mono text-xs">limit</code> +{" "}
              <code className="font-mono text-xs">after</code>); POSTs accept an{" "}
              <code className="font-mono text-xs">Idempotency-Key</code> header so a retry never
              writes twice.
            </p>
          </div>

          {ENDPOINT_GROUPS.map((group) => (
            <div key={group.title} className="space-y-2">
              <div>
                <h4 className="text-sm font-medium">{group.title}</h4>
                <p className="text-xs text-muted-foreground">{group.note}</p>
              </div>
              <div className="divide-y rounded-md border">
                {group.rows.map(([path, desc]) => (
                  <div
                    key={path}
                    className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:items-baseline sm:gap-4"
                  >
                    <code className="shrink-0 font-mono text-xs sm:w-[22rem]">{path}</code>
                    <span className="text-xs text-muted-foreground">{desc}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}

          <p className="text-xs text-muted-foreground">
            Campaigns and sending, and domains and senders, have no endpoints yet — they get their
            own version. Webhooks are set up above rather than over the API. Rate limit: 600
            requests per minute per organization; batch calls count as one.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
