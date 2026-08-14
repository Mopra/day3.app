import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiBaseUrl,
  buildAgentPrompts,
  buildAudiencePanelContent,
  buildAudiencesPanelContent,
  buildDomainsPanelContent,
  buildFieldSnippets,
  buildMcpSetups,
  buildPanelPrompt,
  buildReferenceMarkdown,
  buildSegmentSnippets,
  buildSendersPanelContent,
  buildSnippetTasks,
  buildTopicSnippets,
  exportKeyLine,
  mcpUrl,
  verifyCurl,
  PLACEHOLDER_AUDIENCE,
  PLACEHOLDER_KEY,
  PLACEHOLDER_SEGMENT,
  PLACEHOLDER_TOPIC,
  type ApiDocsContext,
} from "@/lib/api-docs";

// The /api-keys page hands users copy-paste assets. Two things must hold: they
// must never carry a live key off the page, and the reference an AI assistant
// gets must cover every route that actually exists — a documented API that
// silently drifts from the routes is worse than none.

const CTX: ApiDocsContext = {
  origin: "https://go.day3.app",
  audienceId: "aud_test123",
  audienceName: "Product newsletter",
};

const LIVE_KEY = "day3_live_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";

function everySnippet(ctx: ApiDocsContext): string[] {
  return [
    verifyCurl(ctx),
    ...buildSnippetTasks(ctx).flatMap((t) => [t.curl, t.js, t.python]),
    ...buildAgentPrompts(ctx).map((p) => p.text),
    buildReferenceMarkdown(ctx),
    // The API panel's content is copied off the page just the same.
    ...[
      ...buildFieldSnippets(ctx, ["company"]),
      ...buildSegmentSnippets(ctx, { id: "seg_x", name: "Pro" }, ["plan"]),
      ...buildTopicSnippets(ctx, { id: "top_x", name: "News" }),
      ...buildAudiencesPanelContent({ origin: ctx.origin, audiences: [] }).tasks,
    ].flatMap((t) => [t.curl, t.js, t.python]),
    buildPanelPrompt(ctx, { segments: [{ id: "seg_x", name: "Pro" }] }),
  ];
}

describe("api docs assets", () => {
  it("builds the base URL from the app origin", () => {
    expect(apiBaseUrl("https://go.day3.app")).toBe("https://go.day3.app/api/v1");
    expect(apiBaseUrl("https://go.day3.app/")).toBe("https://go.day3.app/api/v1");
  });

  it("puts a live key only in the shell export line", () => {
    expect(exportKeyLine(LIVE_KEY)).toContain(LIVE_KEY);
    expect(exportKeyLine(null)).toContain(PLACEHOLDER_KEY);

    // Nothing else the page offers may embed a real secret — the agent prompts
    // in particular get pasted into third-party chat tools.
    for (const snippet of everySnippet(CTX)) {
      expect(snippet).not.toContain(LIVE_KEY);
      expect(snippet).not.toMatch(/day3_live_[A-Za-z0-9]{40}/);
    }
  });

  it("reads the key from the environment in every language", () => {
    const tasks = buildSnippetTasks(CTX);
    for (const task of tasks) {
      expect(task.curl).toContain("$DAY3_API_KEY");
      expect(task.js).toContain("process.env.DAY3_API_KEY");
      expect(task.python).toContain("DAY3_API_KEY");
    }
  });

  it("substitutes the caller's real audience id", () => {
    const tasks = buildSnippetTasks(CTX);
    const contactTask = tasks.find((t) => t.id === "add")!;
    expect(contactTask.curl).toContain("aud_test123");

    // …and degrades to a placeholder when the account has no audience yet.
    const empty = buildSnippetTasks({ ...CTX, audienceId: PLACEHOLDER_AUDIENCE });
    expect(empty.find((t) => t.id === "add")!.curl).toContain(PLACEHOLDER_AUDIENCE);
  });

  it("ships the full reference inside every agent prompt", () => {
    const reference = buildReferenceMarkdown(CTX);
    const prompts = buildAgentPrompts(CTX);
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt.text).toContain(reference);
      // The audience id is what makes a prompt work without a follow-up question.
      expect(prompt.text).toContain("aud_test123");
    }
  });

  it("tells an agent it has no audience yet rather than inventing one", () => {
    const prompts = buildAgentPrompts({ ...CTX, audienceId: PLACEHOLDER_AUDIENCE });
    for (const prompt of prompts) {
      expect(prompt.text).toContain("POST /audiences");
    }
  });

  it("warns the agent about a capped plan before it writes anything", () => {
    // The cap rejects an oversized import whole, on the first batch — so the
    // assistant has to check the source size up front, not react to a 403.
    const capped = buildAgentPrompts({
      ...CTX,
      subscriberLimit: { cap: 500, used: 88, headroom: 412 },
    });
    for (const prompt of capped) {
      expect(prompt.text).toContain("412");
      expect(prompt.text).toContain("BEFORE writing anything");
      expect(prompt.text).toMatch(/upgrade/i);
    }

    // Paid plans are uncapped — no cap talk at all.
    for (const prompt of buildAgentPrompts(CTX)) {
      expect(prompt.text).not.toMatch(/caps me at/);
    }
  });
});

// ── MCP install snippets ─────────────────────────────────────────────────────

// These are setup commands users paste into whatever shell they happen to have,
// which on Windows is CMD or PowerShell. Neither continues a line with `\`, so a
// wrapped command drops everything after the first line — and the failure is
// silent: the server registers without a credential, 401s, and the client falls
// back to OAuth discovery, surfacing a JSON parse error that never mentions the
// missing header. Keep the shell command on one line.
describe("mcp install snippets", () => {
  const setups = buildMcpSetups(CTX, null);

  it("offers the editors we support", () => {
    expect(setups.map((s) => s.id)).toEqual(["claude-code", "cursor", "vscode"]);
  });

  it("keeps the shell command on one line", () => {
    const shell = setups.find((s) => s.id === "claude-code");
    expect(shell).toBeDefined();
    expect(shell!.code).not.toContain("\\\n");
    expect(shell!.code.trim().split("\n")).toHaveLength(1);
  });

  it("still carries the header the endpoint requires", () => {
    const shell = setups.find((s) => s.id === "claude-code")!;
    expect(shell.code).toContain("--header");
    expect(shell.code).toContain(`Authorization: Bearer ${PLACEHOLDER_KEY}`);
    expect(shell.code).toContain(mcpUrl(CTX.origin));
  });

  // Same bargain exportKeyLine strikes: while the freshly-minted key is still in
  // memory the snippet is paste-and-run, and once it's gone we can only offer the
  // placeholder — a stored key is unrecoverable. VS Code is the exception on
  // purpose: it prompts for the key so the file itself stays clean.
  const embedsKey = (id: string) => id !== "vscode";

  it("fills in a fresh key, falls back to the placeholder", () => {
    for (const setup of buildMcpSetups(CTX, LIVE_KEY).filter((s) => embedsKey(s.id))) {
      expect(setup.code).toContain(LIVE_KEY);
    }
    for (const setup of buildMcpSetups(CTX, null).filter((s) => embedsKey(s.id))) {
      expect(setup.code).toContain(PLACEHOLDER_KEY);
    }
  });

  it("keeps the key out of the VS Code file", () => {
    const vscode = buildMcpSetups(CTX, LIVE_KEY).find((s) => s.id === "vscode")!;
    expect(vscode.code).not.toContain(LIVE_KEY);
    expect(vscode.code).toContain("${input:day3-key}");
  });
});

// ── API panel content ────────────────────────────────────────────────────────

describe("api panel content", () => {
  const SEGMENTS = [{ id: "seg_abc", name: "Pro users" }];
  const TOPICS = [{ id: "top_abc", name: "Product news" }];
  const FIELDS = [{ key: "plan", label: "Plan" }];

  it("scopes snippets to the open audience tab", () => {
    const base = (tab: "contacts" | "fields" | "segments" | "topics") =>
      buildAudiencePanelContent({
        origin: CTX.origin,
        audienceId: CTX.audienceId,
        audienceName: CTX.audienceName,
        tab,
        fields: FIELDS,
        segments: SEGMENTS,
        topics: TOPICS,
      });

    expect(base("contacts").tasks.map((t) => t.id)).toEqual(["add", "unsubscribe", "list"]);
    expect(base("fields").tasks[0].curl).toContain('"plan"');
    expect(base("segments").tasks[0].curl).toContain("seg_abc");
    expect(base("topics").tasks[0].curl).toContain("top_abc");
  });

  it("lists every id the page holds, copy-ready", () => {
    const content = buildAudiencePanelContent({
      origin: CTX.origin,
      audienceId: CTX.audienceId,
      audienceName: CTX.audienceName,
      fields: FIELDS,
      segments: SEGMENTS,
      topics: TOPICS,
    });
    const values = content.idGroups.flatMap((g) => g.rows.map((r) => r.value));
    expect(values).toContain("aud_test123");
    expect(values).toContain("seg_abc");
    expect(values).toContain("top_abc");
    expect(values).toContain("plan"); // field keys, not fld_ ids — the key is what callers use
  });

  it("falls back to placeholders when a tab has no rows yet", () => {
    const empty = buildAudiencePanelContent({
      origin: CTX.origin,
      audienceId: CTX.audienceId,
      audienceName: CTX.audienceName,
      tab: "segments",
      segments: [],
    });
    expect(empty.tasks[0].curl).toContain(PLACEHOLDER_SEGMENT);

    const noTopics = buildAudiencePanelContent({
      origin: CTX.origin,
      audienceId: CTX.audienceId,
      audienceName: CTX.audienceName,
      tab: "topics",
    });
    expect(noTopics.tasks[0].curl).toContain(PLACEHOLDER_TOPIC);
  });

  it("packs the workspace ids and the full reference into the AI prompt", () => {
    const prompt = buildPanelPrompt(CTX, {
      segments: SEGMENTS,
      topics: TOPICS,
      fieldKeys: ["plan"],
    });
    expect(prompt).toContain("aud_test123");
    expect(prompt).toContain("seg_abc");
    expect(prompt).toContain("top_abc");
    expect(prompt).toContain("`plan`");
    expect(prompt).toContain(buildReferenceMarkdown(CTX));
  });

  it("gives the audiences list every audience id and the CRUD snippets", () => {
    const content = buildAudiencesPanelContent({
      origin: CTX.origin,
      audiences: [
        { id: "aud_one", name: "One" },
        { id: "aud_two", name: "Two" },
      ],
    });
    expect(content.idGroups[0].rows.map((r) => r.value)).toEqual(["aud_one", "aud_two"]);
    expect(content.tasks.map((t) => t.id)).toEqual(["list-audiences", "create-audience", "add"]);
    expect(content.prompt).toContain("aud_two");
  });

  it("is honest about domains and senders having no v1 endpoints", () => {
    const domains = buildDomainsPanelContent({
      origin: CTX.origin,
      domains: [{ id: "dom_abc", domain: "news.acme.com" }],
    });
    expect(domains.tasks).toEqual([]);
    expect(domains.prompt).toBeNull();
    expect(domains.note).toMatch(/don't have public API endpoints yet/);
    expect(domains.idGroups[0].rows[0]).toEqual({ label: "news.acme.com", value: "dom_abc" });

    const senders = buildSendersPanelContent({
      origin: CTX.origin,
      senders: [{ id: "snd_abc", fromName: "Acme", fromEmail: "news@acme.com" }],
    });
    expect(senders.tasks).toEqual([]);
    expect(senders.prompt).toBeNull();
    expect(senders.idGroups[0].rows[0].value).toBe("snd_abc");
  });
});

// ── Drift guard ──────────────────────────────────────────────────────────────

/** Every route.ts under app/api/v1, as the public path it serves. */
function v1RoutePaths(): string[] {
  const root = path.resolve(__dirname, "..", "app", "api", "v1");
  const found: string[] = [];

  const walk = (dir: string, segments: string[]) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full, [...segments, entry]);
      } else if (entry === "route.ts") {
        found.push("/" + segments.join("/"));
      }
    }
  };
  walk(root, []);
  return found;
}

describe("reference covers the real routes", () => {
  const reference = buildReferenceMarkdown(CTX);

  // Next's dynamic segments ([audienceId]) map onto the reference's own
  // placeholder vocabulary ({aud}, {id}, …). Compare on the static segments —
  // enough to catch a whole resource shipping undocumented.
  const staticSegments = (routePath: string) =>
    routePath.split("/").filter((s) => s && !s.startsWith("["));

  it.each(v1RoutePaths())("documents %s", (routePath) => {
    for (const segment of staticSegments(routePath)) {
      expect(reference).toContain(segment);
    }
  });

  it("documents the vocabulary a caller has to get right", () => {
    for (const needle of [
      "Idempotency-Key",
      "next_cursor",
      "has_more",
      "?upsert=true",
      "batch",
      "email_suppressed",
      "rate_limit_exceeded",
      "request_id",
      "DAY3_API_KEY",
    ]) {
      expect(reference).toContain(needle);
    }
  });
});
