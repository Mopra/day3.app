import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  apiBaseUrl,
  buildAgentPrompts,
  buildReferenceMarkdown,
  buildSnippetTasks,
  exportKeyLine,
  verifyCurl,
  PLACEHOLDER_AUDIENCE,
  PLACEHOLDER_KEY,
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
