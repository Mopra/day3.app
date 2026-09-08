import { beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import type { Db } from "../src/db/client";
import {
  automationEdges,
  automationEnrollments,
  automationNodes,
  automationVersions,
  automations,
  campaignRecipients,
  type Account,
  type Audience,
  type SendingDomain,
} from "../src/db/schema";
import type { SendEmailInput, SendEmailResult } from "../src/email/provider";
import type { DraftGraphInput } from "../src/lib/automation-types";
import { newId, nowIso } from "../src/lib/ids";
import type { QueueMessage } from "../src/queue/messages";
import {
  FakeQueue,
  seedAccount,
  seedAudience,
  seedDomain,
  seedMember,
  seedSender,
  seedSubscribers,
  testDb,
} from "./helpers";

// The automation service against a hermetic pglite database. The engine's real
// enrollment path runs (it only needs Postgres); the three seams that leave the
// process are replaced: the job queue, the email provider and the unsubscribe
// secret. AI_REVIEW_MODE is unset, so risk review is the deterministic pass.

const queue = new FakeQueue();
vi.mock("../src/queue/producer", () => ({ getQueue: () => queue }));

vi.mock("../src/lib/env", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/env")>()),
  requireUnsubscribeSecret: () => "x".repeat(32),
}));

let sends: SendEmailInput[] = [];
vi.mock("../src/email/factory", () => ({
  emailProviderFromEnv: () => ({
    send: async (input: SendEmailInput): Promise<SendEmailResult> => {
      sends.push(input);
      return { provider: "mock", messageId: `m_${sends.length}`, status: "sent" };
    },
  }),
}));

const svc = await import("../src/services/automations");
const { AUTOMATION_TEMPLATES, buildTemplateGraph, templateSummaries } = await import(
  "../src/lib/automation-templates"
);
const { validateGraph, SendNodeConfigSchema } = await import("../src/lib/automation-graph");
const { sanitizeHtml } = await import("../src/services/render");

let db: Db;
let account: Account;
let audience: Audience;
let domain: SendingDomain;

beforeEach(async () => {
  db = await testDb();
  queue.messages.length = 0;
  queue.delays.length = 0;
  sends = [];
  delete process.env.AI_REVIEW_MODE;
  process.env.APP_URL = "https://app.day3.test";
  account = await seedAccount(db);
  domain = await seedDomain(db, account.id);
  await seedSender(db, account.id, domain.id, { isDefault: true });
  audience = await seedAudience(db, account.id);
});

// A send node with real, harmless content, as the canvas would send it: the
// client authors sectionsJson; htmlBody is derived server-side.
function sendNode(key: string, subject: string, body: string, y = 150): DraftGraphInput["nodes"][number] {
  return {
    key,
    kind: "send",
    label: null,
    x: 0,
    y,
    config: {
      subject,
      previewText: null,
      sectionsJson: JSON.stringify([
        { id: "sec_1", kind: "text", columns: 1, content: [`<p>${body}</p>`] },
      ]),
      htmlBody: "<script>alert(1)</script>client-authored",
      textBody: null,
      allowResend: false,
    },
  };
}

function linearDraft(sendKey = "nd_send1", subject = "Hello", body = "Welcome to the team."): DraftGraphInput {
  return {
    nodes: [
      { key: "nd_trigger", kind: "trigger", config: {}, label: null, x: 0, y: 0 },
      sendNode(sendKey, subject, body),
      { key: "nd_end", kind: "end", config: {}, label: null, x: 0, y: 300 },
    ],
    edges: [
      { fromKey: "nd_trigger", port: "next", toKey: sendKey },
      { fromKey: sendKey, port: "next", toKey: "nd_end" },
    ],
  };
}

async function publishedAutomation(opts: { plan?: string } = {}) {
  if (opts.plan) {
    await db.update(automations).set({}).where(eq(automations.id, "noop"));
  }
  const created = await svc.createAutomation(db, account, { name: "Welcome", audienceId: audience.id });
  await svc.saveDraftGraph(db, account, created.id, linearDraft());
  const result = await svc.publishAutomation(db, account, created.id, "user_test");
  if (!result.ok) throw new Error(`publish failed: ${JSON.stringify(result.validation)}`);
  return result.detail;
}

describe("automation templates", () => {
  it("ship four flows that all pass publish validation", () => {
    expect(AUTOMATION_TEMPLATES.map((t) => t.key)).toEqual([
      "welcome",
      "welcome-series",
      "trial-onboarding",
      "win-back",
    ]);
    for (const template of AUTOMATION_TEMPLATES) {
      const graph = template.build();
      const validation = validateGraph({
        nodes: graph.nodes.map((n) => ({ key: n.key, kind: n.kind, config: n.config, label: n.label })),
        edges: graph.edges,
      });
      expect(validation.errors, template.key).toEqual([]);
    }
  });

  it("derives every send node's htmlBody from its sections and keeps it sanitizer-stable", () => {
    for (const template of AUTOMATION_TEMPLATES) {
      for (const node of template.build().nodes) {
        if (node.kind !== "send") continue;
        const config = SendNodeConfigSchema.parse(node.config);
        expect(config.htmlBody.length).toBeGreaterThan(0);
        expect(sanitizeHtml(config.htmlBody)).toBe(config.htmlBody);
        // No em or en dash anywhere in shipped copy (a hard house rule).
        for (const s of [config.htmlBody, config.subject, config.previewText ?? ""]) {
          expect(s).not.toMatch(/[\u2013\u2014]/);
        }
      }
    }
  });

  it("mints fresh node keys per build and reports honest node counts", () => {
    const a = buildTemplateGraph("welcome-series")!;
    const b = buildTemplateGraph("welcome-series")!;
    expect(a.nodes.map((n) => n.key)).not.toEqual(b.nodes.map((n) => n.key));
    for (const node of a.nodes) expect(node.key).toMatch(/^nd_[0-9a-z]{1,40}$/);

    const summaries = templateSummaries();
    expect(summaries.find((s) => s.key === "welcome")!.nodeCount).toBe(3);
    expect(summaries.find((s) => s.key === "welcome-series")!.nodeCount).toBe(7);
    expect(buildTemplateGraph("nope")).toBeNull();
  });

  it("wires the win-back branch to its own first send", () => {
    const graph = buildTemplateGraph("win-back")!;
    const branch = graph.nodes.find((n) => n.kind === "branch")!;
    const condition = (branch.config as { condition: { kind: string; nodeKey?: string } }).condition;
    expect(condition.kind).toBe("engagement");
    expect(graph.nodes.some((n) => n.kind === "send" && n.key === condition.nodeKey)).toBe(true);
  });
});

describe("createAutomation", () => {
  it("creates a draft with a version-0 draft, a lone trigger and the default sender", async () => {
    const detail = await svc.createAutomation(db, account, { name: "Blank", audienceId: audience.id });
    expect(detail.status).toBe("draft");
    expect(detail.liveVersion).toBeNull();
    expect(detail.live).toBeNull();
    expect(detail.draftDirty).toBe(true);
    expect(detail.draft.nodes).toHaveLength(1);
    expect(detail.draft.nodes[0].kind).toBe("trigger");
    expect(detail.validation.errors).toEqual([]);
    expect(detail.fromEmail).toBe("news@updates.test.co");
    expect(detail.sendingDomainId).toBe(domain.id);
    expect(detail.audienceName).toBe("Test audience");
    expect(detail.timezone).toBe("UTC");
    expect(detail.reentry).toBe("once");
    expect(detail.triggerKind).toBe("audience_join");

    const version = await db.query.automationVersions.findFirst({
      where: eq(automationVersions.id, detail.draftVersionId),
    });
    expect(version?.version).toBe(0);
    expect(version?.status).toBe("draft");
  });

  it("seeds the graph from a template", async () => {
    const detail = await svc.createAutomation(db, account, {
      name: "Series",
      audienceId: audience.id,
      templateKey: "welcome-series",
    });
    expect(detail.draft.nodes).toHaveLength(7);
    expect(detail.draft.edges).toHaveLength(6);
    expect(detail.validation.ok).toBe(true);
    // Templates are laid out, not piled at the origin.
    expect(new Set(detail.draft.nodes.map((n) => n.y)).size).toBeGreaterThan(1);
  });

  it("refuses another account's audience, an unknown template, and the per-account cap", async () => {
    const other = await seedAccount(db);
    const otherAudience = await seedAudience(db, other.id);
    await expect(
      svc.createAutomation(db, account, { name: "x", audienceId: otherAudience.id }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      svc.createAutomation(db, account, { name: "x", audienceId: audience.id, templateKey: "nope" }),
    ).rejects.toMatchObject({ status: 400, message: "Unknown template" });

    const now = nowIso();
    await db.insert(automations).values(
      Array.from({ length: 50 }, () => ({
        id: newId("aut"),
        accountId: account.id,
        audienceId: audience.id,
        name: "filler",
        status: "draft" as const,
        triggerKind: "audience_join" as const,
        createdAt: now,
        updatedAt: now,
      })),
    );
    await expect(
      svc.createAutomation(db, account, { name: "one too many", audienceId: audience.id }),
    ).rejects.toMatchObject({ status: 400 });
  });
});

describe("saveDraftGraph", () => {
  it("derives htmlBody from sections server-side and never stores the client's htmlBody", async () => {
    const created = await svc.createAutomation(db, account, { name: "W", audienceId: audience.id });
    const detail = await svc.saveDraftGraph(db, account, created.id, linearDraft());
    const send = detail.draft.nodes.find((n) => n.kind === "send")!;
    const config = SendNodeConfigSchema.parse(send.config);
    expect(config.htmlBody).toContain("Welcome to the team.");
    expect(config.htmlBody).not.toContain("client-authored");
    expect(config.htmlBody).not.toContain("<script>");
    expect(detail.validation.ok).toBe(true);
    expect(detail.draftDirty).toBe(true);

    // A save replaces the draft wholesale: the old rows are gone.
    const rows = await db
      .select()
      .from(automationNodes)
      .where(eq(automationNodes.automationVersionId, detail.draftVersionId));
    expect(rows).toHaveLength(3);
  });

  it("tolerates a half-edited draft but rejects structural garbage", async () => {
    const created = await svc.createAutomation(db, account, { name: "W", audienceId: audience.id });
    // A send with no content saves fine; validation reports it.
    const half = await svc.saveDraftGraph(db, account, created.id, {
      nodes: [
        { key: "nd_trigger", kind: "trigger", config: {}, x: 0, y: 0 },
        { key: "nd_send1", kind: "send", config: { subject: "" }, x: 0, y: 100 },
      ],
      edges: [{ fromKey: "nd_trigger", port: "next", toKey: "nd_send1" }],
    });
    expect(half.validation.ok).toBe(false);
    expect(half.validation.errors.map((e) => e.code)).toContain("send_missing_content");

    await expect(
      svc.saveDraftGraph(db, account, created.id, {
        nodes: [
          { key: "nd_a", kind: "trigger", config: {}, x: 0, y: 0 },
          { key: "nd_a", kind: "end", config: {}, x: 0, y: 0 },
        ],
        edges: [],
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      svc.saveDraftGraph(db, account, created.id, {
        nodes: [
          { key: "nd_a", kind: "trigger", config: {}, x: 0, y: 0 },
          { key: "nd_b", kind: "end", config: {}, x: 0, y: 0 },
        ],
        edges: [{ fromKey: "nd_a", port: "yes", toKey: "nd_b" }],
      }),
    ).rejects.toMatchObject({ status: 400 });

    await expect(
      svc.saveDraftGraph(db, account, created.id, {
        nodes: Array.from({ length: 101 }, (_, i) => ({
          key: `nd_n${i}`,
          kind: "end" as const,
          config: {},
          x: 0,
          y: 0,
        })),
        edges: [],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("bounds the opaque config of non-send nodes", async () => {
    const created = await svc.createAutomation(db, account, { name: "W", audienceId: audience.id });
    await expect(
      svc.saveDraftGraph(db, account, created.id, {
        nodes: [
          { key: "nd_trigger", kind: "trigger", config: {}, x: 0, y: 0 },
          { key: "nd_wait", kind: "wait", config: { value: 1, unit: "days", junk: "x".repeat(30_000) }, x: 0, y: 100 },
        ],
        edges: [],
      }),
    ).rejects.toMatchObject({ status: 400, message: /too much configuration/ });
    // A real branch filter is nowhere near the ceiling.
    const ok = await svc.saveDraftGraph(db, account, created.id, {
      nodes: [
        { key: "nd_trigger", kind: "trigger", config: {}, x: 0, y: 0 },
        {
          key: "nd_branch",
          kind: "branch",
          config: {
            condition: {
              kind: "filter",
              filter: {
                match: "all",
                conditions: Array.from({ length: 10 }, (_, i) => ({
                  field: `f${i}`,
                  op: "equals",
                  value: "v".repeat(500),
                })),
              },
            },
          },
          x: 0,
          y: 100,
        },
      ],
      edges: [{ fromKey: "nd_trigger", port: "next", toKey: "nd_branch" }],
    });
    expect(ok.draft.nodes).toHaveLength(2);
  });
});

describe("updateAutomationSettings", () => {
  it("resolves a sender into the From snapshot and validates ownership", async () => {
    const created = await svc.createAutomation(db, account, { name: "W", audienceId: audience.id });
    const other = await seedSender(db, account.id, domain.id, {
      fromName: "Support",
      fromEmail: "help@updates.test.co",
      replyTo: "reply@updates.test.co",
    });
    const detail = await svc.updateAutomationSettings(db, account, created.id, {
      name: "Renamed",
      senderId: other.id,
      triggerKind: "api",
      reentry: "always",
      entryFilter: { match: "all", conditions: [{ field: "plan", op: "equals", value: "trial" }] },
      sendWindow: { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" },
      timezone: "Europe/Copenhagen",
      theme: { pageBg: "#000000" },
    });
    expect(detail.name).toBe("Renamed");
    expect(detail.senderId).toBe(other.id);
    expect(detail.fromEmail).toBe("help@updates.test.co");
    expect(detail.fromName).toBe("Support");
    expect(detail.replyTo).toBe("reply@updates.test.co");
    expect(detail.triggerKind).toBe("api");
    expect(detail.reentry).toBe("always");
    expect(detail.entryFilter?.conditions[0].field).toBe("plan");
    expect(detail.sendWindow).toEqual({ days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" });
    expect(detail.timezone).toBe("Europe/Copenhagen");
    expect(detail.theme?.pageBg).toBe("#000000");
    expect(detail.theme?.contentBg).toBe("#ffffff"); // resolved against the defaults

    const stranger = await seedAccount(db);
    const strangerDomain = await seedDomain(db, stranger.id, { domain: "x.stranger.co" });
    const strangerSender = await seedSender(db, stranger.id, strangerDomain.id, {
      fromEmail: "a@x.stranger.co",
    });
    await expect(
      svc.updateAutomationSettings(db, account, created.id, { senderId: strangerSender.id }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      svc.updateAutomationSettings(db, account, created.id, { fromEmail: "me@elsewhere.com" }),
    ).rejects.toMatchObject({ status: 400 });

    // Clearing a nullable field with explicit null.
    const cleared = await svc.updateAutomationSettings(db, account, created.id, {
      entryFilter: null,
      sendWindow: null,
    });
    expect(cleared.entryFilter).toBeNull();
    expect(cleared.sendWindow).toBeNull();
  });

  it("validates the schema's timezone and send window shape", () => {
    expect(svc.AutomationSettingsSchema.safeParse({ timezone: "Mars/Olympus" }).success).toBe(false);
    expect(svc.AutomationSettingsSchema.safeParse({ timezone: "America/New_York" }).success).toBe(true);
    expect(
      svc.AutomationSettingsSchema.safeParse({ sendWindow: { days: [7], from: "09:00", to: "17:00" } })
        .success,
    ).toBe(false);
    expect(svc.AutomationSettingsSchema.safeParse({ triggerKind: "segment_join" }).success).toBe(false);

    // A day listed twice, an inverted window and an empty window are all things
    // the engine would silently treat as "no window"; refuse them at the door.
    const window = (w: object) => svc.AutomationSettingsSchema.safeParse({ sendWindow: w }).success;
    expect(window({ days: [1, 1], from: "09:00", to: "17:00" })).toBe(false);
    expect(window({ days: [1], from: "17:00", to: "09:00" })).toBe(false);
    expect(window({ days: [1], from: "09:00", to: "09:00" })).toBe(false);
    expect(window({ days: [0, 6], from: "09:00", to: "09:01" })).toBe(true);
  });
});

describe("publishAutomation", () => {
  it("blocks on the same gates a campaign submit checks, in the validation shape", async () => {
    const created = await svc.createAutomation(db, account, { name: "W", audienceId: audience.id });
    await svc.saveDraftGraph(db, account, created.id, linearDraft());

    // No From identity.
    await svc.updateAutomationSettings(db, account, created.id, { senderId: null, fromEmail: null, sendingDomainId: null });
    let result = await svc.publishAutomation(db, account, created.id, "user_test");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.validation.errors.map((e) => e.message).join(" ")).toMatch(/From address/);

    // Unverified domain.
    const pending = await seedDomain(db, account.id, {
      domain: "pending.test.co",
      verificationStatus: "pending",
    });
    await svc.updateAutomationSettings(db, account, created.id, {
      sendingDomainId: pending.id,
      fromEmail: "hi@pending.test.co",
      fromName: "Hi",
    });
    result = await svc.publishAutomation(db, account, created.id, "user_test");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.validation.errors.map((e) => e.message).join(" ")).toMatch(/Verify your sending domain/);

    // Missing business address.
    await svc.updateAutomationSettings(db, account, created.id, {
      sendingDomainId: domain.id,
      fromEmail: "news@updates.test.co",
    });
    const noAddress = { ...account, companyAddress: null };
    result = await svc.publishAutomation(db, noAddress, created.id, "user_test");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.validation.errors.map((e) => e.message).join(" ")).toMatch(/mailing address/);

    // Graph errors are reported alongside, and nothing was published.
    const row = await db.query.automations.findFirst({ where: eq(automations.id, created.id) });
    expect(row?.liveVersionId).toBeNull();
    expect(row?.status).toBe("draft");
  });

  it("publishes a copy as version 1, records risk on send nodes and leaves the draft editable", async () => {
    const detail = await publishedAutomation();
    expect(detail.status).toBe("active");
    expect(detail.sandbox).toBe(false);
    expect(detail.liveVersion?.version).toBe(1);
    expect(detail.liveVersion?.publishedAt).toBeTruthy();
    expect(detail.live?.nodes.map((n) => n.key).sort()).toEqual(["nd_end", "nd_send1", "nd_trigger"]);
    expect(detail.live?.edges).toHaveLength(2);
    expect(detail.draftDirty).toBe(false);

    const liveSend = detail.live!.nodes.find((n) => n.key === "nd_send1")!;
    expect(liveSend.risk?.level).toBe("low");
    // Draft rows carry no verdict; only published rows do.
    expect(detail.draft.nodes.find((n) => n.key === "nd_send1")!.risk).toBeNull();

    const version = await db.query.automationVersions.findFirst({
      where: eq(automationVersions.id, detail.liveVersion!.id),
    });
    expect(version?.status).toBe("published");
    expect(version?.publishedBy).toBe("user_test");

    // Editing the draft afterwards makes it dirty without touching the live copy.
    const edited = await svc.saveDraftGraph(
      db,
      account,
      detail.id,
      linearDraft("nd_send1", "Hello again", "Still welcome."),
    );
    expect(edited.draftDirty).toBe(true);
    expect(edited.liveVersion?.version).toBe(1);
    const liveConfig = SendNodeConfigSchema.parse(edited.live!.nodes.find((n) => n.key === "nd_send1")!.config);
    expect(liveConfig.subject).toBe("Hello");

    // Moving nodes around is not a change worth publishing.
    const moved = await svc.saveDraftGraph(db, account, detail.id, {
      ...linearDraft(),
      nodes: linearDraft().nodes.map((n) => ({ ...n, x: n.x + 400 })),
    });
    expect(moved.draftDirty).toBe(false);
  });

  it("supersedes the previous live version on republish and keeps a pause", async () => {
    const first = await publishedAutomation();
    await svc.pauseAutomation(db, account, first.id);
    await svc.saveDraftGraph(db, account, first.id, linearDraft("nd_send1", "v2 subject", "Body two."));
    const result = await svc.publishAutomation(db, account, first.id, "user_test");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.detail.liveVersion?.version).toBe(2);
    expect(result.detail.status).toBe("paused");

    const old = await db.query.automationVersions.findFirst({
      where: eq(automationVersions.id, first.liveVersion!.id),
    });
    expect(old?.status).toBe("superseded");
    // The old version's rows are intact for the enrollments pinned to it.
    const oldNodes = await db
      .select()
      .from(automationNodes)
      .where(eq(automationNodes.automationVersionId, first.liveVersion!.id));
    expect(oldNodes).toHaveLength(3);
  });

  it("blocks publish when a send node fails the safety review, naming the node", async () => {
    const created = await svc.createAutomation(db, account, { name: "W", audienceId: audience.id });
    await svc.saveDraftGraph(
      db,
      account,
      created.id,
      linearDraft("nd_send1", "Big jackpot", "Join our casino tonight for the jackpot."),
    );
    const result = await svc.publishAutomation(db, account, created.id, "user_test");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    const issue = result.validation.errors.find((e) => e.nodeKey === "nd_send1");
    expect(issue?.message).toMatch(/safety review/);
    expect(issue?.message).toMatch(/gambling/i);
    const row = await db.query.automations.findFirst({ where: eq(automations.id, created.id) });
    expect(row?.liveVersionId).toBeNull();
  });

  it("blocks a past-due account and a From address that is not on the selected domain", async () => {
    const created = await svc.createAutomation(db, account, { name: "W", audienceId: audience.id });
    await svc.saveDraftGraph(db, account, created.id, linearDraft());

    // Same account gate a campaign submit runs.
    const pastDue = { ...account, subscriptionStatus: "past_due" };
    let result = await svc.publishAutomation(db, pastDue, created.id, "user_test");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.validation.errors.map((e) => e.message).join(" ")).toMatch(/past due/);

    // Settings keep the two aligned, so drift can only come from below them.
    await db.update(automations).set({ fromEmail: "news@elsewhere.com" }).where(eq(automations.id, created.id));
    result = await svc.publishAutomation(db, account, created.id, "user_test");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.validation.errors.map((e) => e.message).join(" ")).toMatch(/must use the selected sending domain/);
    const row = await db.query.automations.findFirst({ where: eq(automations.id, created.id) });
    expect(row?.liveVersionId).toBeNull();
  });

  it("supersedes every version that is still published, not only the one it remembered", async () => {
    const first = await publishedAutomation();
    // A publish that landed between this call's read and its transaction would
    // leave a second "published" row behind. Plant one.
    const now = nowIso();
    const strayId = newId("aev");
    await db.insert(automationVersions).values({
      id: strayId,
      accountId: account.id,
      automationId: first.id,
      version: 2,
      status: "published",
      publishedAt: now,
      publishedBy: "user_other",
      createdAt: now,
      updatedAt: now,
    });
    const result = await svc.publishAutomation(db, account, first.id, "user_test");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.detail.liveVersion?.version).toBe(3);
    const versions = await db
      .select({ id: automationVersions.id, version: automationVersions.version, status: automationVersions.status })
      .from(automationVersions)
      .where(eq(automationVersions.automationId, first.id));
    expect(versions.filter((v) => v.status === "published").map((v) => v.version)).toEqual([3]);
    expect(versions.find((v) => v.id === strayId)?.status).toBe("superseded");
    expect(versions.find((v) => v.id === first.liveVersion!.id)?.status).toBe("superseded");
  });

  it("publishes a free org in sandbox mode", async () => {
    const free = await seedAccount(db, { plan: "free_org", sendingEnabled: false });
    const freeDomain = await seedDomain(db, free.id);
    await seedSender(db, free.id, freeDomain.id, { isDefault: true });
    const freeAudience = await seedAudience(db, free.id);
    const created = await svc.createAutomation(db, free, { name: "W", audienceId: freeAudience.id });
    await svc.saveDraftGraph(db, free, created.id, linearDraft());
    const result = await svc.publishAutomation(db, free, created.id, "user_test");
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.detail.sandbox).toBe(true);
    expect(result.detail.status).toBe("active");
  });

  it("refuses a paused account and an archived automation", async () => {
    const created = await svc.createAutomation(db, account, { name: "W", audienceId: audience.id });
    await svc.saveDraftGraph(db, account, created.id, linearDraft());
    const paused = { ...account, riskStatus: "paused", pausedReason: "bounce rate" };
    const result = await svc.publishAutomation(db, paused, created.id, "user_test");
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.validation.errors.map((e) => e.message).join(" ")).toMatch(/paused/);

    const live = await publishedAutomation();
    await svc.archiveAutomation(db, account, live.id);
    await expect(svc.publishAutomation(db, account, live.id, "user_test")).rejects.toMatchObject({ status: 409 });
    await expect(svc.saveDraftGraph(db, account, live.id, linearDraft())).rejects.toMatchObject({ status: 409 });
  });
});

describe("pause, resume, archive", () => {
  it("flips status and refuses impossible transitions", async () => {
    const detail = await publishedAutomation();
    const paused = await svc.pauseAutomation(db, account, detail.id);
    expect(paused.status).toBe("paused");
    await expect(svc.pauseAutomation(db, account, detail.id)).rejects.toMatchObject({ status: 409 });
    const resumed = await svc.resumeAutomation(db, account, detail.id);
    expect(resumed.status).toBe("active");
    await expect(svc.resumeAutomation(db, account, detail.id)).rejects.toMatchObject({ status: 409 });

    const draft = await svc.createAutomation(db, account, { name: "D", audienceId: audience.id });
    await expect(svc.pauseAutomation(db, account, draft.id)).rejects.toMatchObject({ status: 409 });
  });

  it("hard-deletes a never-published draft and archives a live one, exiting its enrollments", async () => {
    const draft = await svc.createAutomation(db, account, { name: "D", audienceId: audience.id, templateKey: "welcome" });
    await svc.archiveAutomation(db, account, draft.id);
    expect(await db.query.automations.findFirst({ where: eq(automations.id, draft.id) })).toBeUndefined();
    expect(
      await db.select().from(automationVersions).where(eq(automationVersions.automationId, draft.id)),
    ).toEqual([]);
    expect(
      await db.select().from(automationNodes).where(eq(automationNodes.automationVersionId, draft.draftVersionId)),
    ).toEqual([]);
    expect(
      await db.select().from(automationEdges).where(eq(automationEdges.automationVersionId, draft.draftVersionId)),
    ).toEqual([]);

    const live = await publishedAutomation();
    const [alice] = await seedSubscribers(db, account.id, audience.id, ["alice@example.com"]);
    const automation = (await svc.findAutomationOr404(db, account.id, live.id))!;
    const enrolled = await svc.enrollByEmail(db, account, automation, alice.email, "manual");
    expect(enrolled.outcome).toBe("enrolled");

    await svc.archiveAutomation(db, account, live.id);
    const row = await db.query.automations.findFirst({ where: eq(automations.id, live.id) });
    expect(row?.status).toBe("archived");
    const enrollment = await db.query.automationEnrollments.findFirst({
      where: eq(automationEnrollments.id, enrolled.enrollmentId!),
    });
    expect(enrollment?.status).toBe("exited");
    expect(enrollment?.exitReason).toBe("automation_archived");
    expect(enrollment?.exitedAt).toBeTruthy();
    // Archived flows leave the list.
    const { listAutomations } = await import("../src/api/lists");
    expect((await listAutomations(db, account.id)).map((a) => a.id)).not.toContain(live.id);
  });
});

describe("enrollments", () => {
  it("enrolls an existing contact by email, reports a missing one, and pages the list", async () => {
    const detail = await publishedAutomation();
    const automation = (await svc.findAutomationOr404(db, account.id, detail.id))!;
    const [alice] = await seedSubscribers(db, account.id, audience.id, ["alice@example.com"]);

    expect(await svc.enrollByEmail(db, account, automation, "nobody@example.com", "manual")).toEqual({
      outcome: "not_subscribed",
      enrollmentId: null,
    });

    const result = await svc.enrollByEmail(db, account, automation, "Alice@Example.com", "manual");
    expect(result.outcome).toBe("enrolled");
    expect(result.enrollmentId).toMatch(/^aen_/);
    expect(queue.messages).toEqual([
      { type: "advance_automation_enrollment", enrollmentId: result.enrollmentId, accountId: account.id },
    ]);

    // Re-entry `once`: a second attempt is refused by the database.
    expect((await svc.enrollByEmail(db, account, automation, alice.email, "manual")).outcome).toBe(
      "already_enrolled",
    );

    const page = await svc.listEnrollments(db, account.id, detail.id, { offset: 0, limit: 10 });
    expect(page.total).toBe(1);
    expect(page.rows[0]).toMatchObject({
      id: result.enrollmentId,
      email: "alice@example.com",
      status: "active",
      versionNumber: 1,
      currentNodeKey: "nd_trigger",
      sandbox: false,
    });
    const none = await svc.listEnrollments(db, account.id, detail.id, {
      status: "completed",
      offset: 0,
      limit: 10,
    });
    expect(none.total).toBe(0);

    const counts = (await svc.getAutomationDetail(db, account.id, detail.id))!.counts;
    expect(counts).toEqual({ active: 1, sending: 0, completed: 0, exited: 0, failed: 0, total: 1 });
  });

  it("run-now pulls next_run_at forward and pokes the engine; exit stops the run", async () => {
    const detail = await publishedAutomation();
    const automation = (await svc.findAutomationOr404(db, account.id, detail.id))!;
    await seedSubscribers(db, account.id, audience.id, ["alice@example.com"]);
    const { enrollmentId } = await svc.enrollByEmail(db, account, automation, "alice@example.com", "manual");
    queue.messages.length = 0;

    // Park it in the future, as a wait node would.
    await db
      .update(automationEnrollments)
      .set({ nextRunAt: new Date(Date.now() + 86_400_000).toISOString() })
      .where(eq(automationEnrollments.id, enrollmentId!));

    await svc.runEnrollmentNow(db, account.id, detail.id, enrollmentId!);
    const row = await db.query.automationEnrollments.findFirst({
      where: eq(automationEnrollments.id, enrollmentId!),
    });
    expect(Date.parse(row!.nextRunAt!)).toBeLessThanOrEqual(Date.now());
    expect(queue.messages).toEqual<QueueMessage[]>([
      { type: "advance_automation_enrollment", enrollmentId: enrollmentId!, accountId: account.id },
    ]);

    await svc.exitEnrollment(db, account.id, detail.id, enrollmentId!);
    const exited = await db.query.automationEnrollments.findFirst({
      where: eq(automationEnrollments.id, enrollmentId!),
    });
    expect(exited?.status).toBe("exited");
    expect(exited?.exitReason).toBe("manual");
    await expect(svc.runEnrollmentNow(db, account.id, detail.id, enrollmentId!)).rejects.toMatchObject({
      status: 409,
    });
    await expect(svc.exitEnrollment(db, account.id, detail.id, enrollmentId!)).rejects.toMatchObject({
      status: 409,
    });
    await expect(svc.exitEnrollment(db, account.id, detail.id, "aen_missing")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("keeps a sandbox automation to org members", async () => {
    const free = await seedAccount(db, { plan: "free_org", sendingEnabled: false });
    const freeDomain = await seedDomain(db, free.id);
    await seedSender(db, free.id, freeDomain.id, { isDefault: true });
    const freeAudience = await seedAudience(db, free.id);
    await seedMember(db, free.id, "founder@example.com");
    await seedSubscribers(db, free.id, freeAudience.id, ["founder@example.com", "stranger@example.com"]);
    const created = await svc.createAutomation(db, free, { name: "W", audienceId: freeAudience.id });
    await svc.saveDraftGraph(db, free, created.id, linearDraft());
    const published = await svc.publishAutomation(db, free, created.id, "user_test");
    if (!published.ok) throw new Error("publish failed");
    const automation = (await svc.findAutomationOr404(db, free.id, created.id))!;
    expect((await svc.enrollByEmail(db, free, automation, "stranger@example.com", "api")).outcome).toBe(
      "sandbox_not_member",
    );
    const ok = await svc.enrollByEmail(db, free, automation, "founder@example.com", "api");
    expect(ok.outcome).toBe("enrolled");
    const row = await db.query.automationEnrollments.findFirst({
      where: eq(automationEnrollments.id, ok.enrollmentId!),
    });
    expect(row?.sandbox).toBe(true);
  });
});

describe("enrollContactByApi", () => {
  it("refuses an inactive automation with a 409, creates the contact when attributes are given", async () => {
    const draft = await svc.createAutomation(db, account, { name: "D", audienceId: audience.id });
    const draftRow = (await svc.findAutomationOr404(db, account.id, draft.id))!;
    await expect(
      svc.enrollContactByApi(db, account, draftRow, { email: "a@example.com" }),
    ).rejects.toMatchObject({ status: 409, code: "invalid_request" });

    const detail = await publishedAutomation();
    const automation = (await svc.findAutomationOr404(db, account.id, detail.id))!;

    // No attributes: a missing contact is reported, never created.
    expect(await svc.enrollContactByApi(db, account, automation, { email: "new@example.com" })).toEqual({
      outcome: "not_subscribed",
      enrollmentId: null,
    });

    const result = await svc.enrollContactByApi(db, account, automation, {
      email: "New@Example.com",
      attributes: { plan: "trial" },
    });
    expect(result.outcome).toBe("enrolled");
    const contact = await db.query.subscribers.findFirst({
      where: (t, { eq: e }) => e(t.email, "new@example.com"),
    });
    expect(contact?.status).toBe("subscribed");
    expect(contact?.attributes).toEqual({ plan: "trial" });
    expect(contact?.source).toBe("api");

    await expect(
      svc.enrollContactByApi(db, account, automation, { email: "not-an-email" }),
    ).rejects.toMatchObject({ status: 400, code: "invalid_email" });
  });

  it("enrolls a brand-new contact exactly once when the audience-join hook already fired", async () => {
    const detail = await publishedAutomation();
    // Under `always` there is no unique index to refuse the second insert, so
    // the hook's enrollment plus an explicit one would be two runs for one call.
    await svc.updateAutomationSettings(db, account, detail.id, { reentry: "always" });
    const automation = (await svc.findAutomationOr404(db, account.id, detail.id))!;
    expect(automation.triggerKind).toBe("audience_join");

    const result = await svc.enrollContactByApi(db, account, automation, {
      email: "fresh@example.com",
      attributes: { plan: "trial" },
    });
    expect(result.outcome).toBe("enrolled");
    const contact = (await db.query.subscribers.findFirst({
      where: (t, { eq: e }) => e(t.email, "fresh@example.com"),
    }))!;
    const rows = await db
      .select()
      .from(automationEnrollments)
      .where(eq(automationEnrollments.subscriberId, contact.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(result.enrollmentId);

    // An existing subscriber is not the hook's business: the explicit enroll
    // makes the run, and under `always` a second call makes another.
    const [bob] = await seedSubscribers(db, account.id, audience.id, ["bob@example.com"]);
    const one = await svc.enrollContactByApi(db, account, automation, { email: bob.email, attributes: { plan: "pro" } });
    const two = await svc.enrollContactByApi(db, account, automation, { email: bob.email });
    expect([one.outcome, two.outcome]).toEqual(["enrolled", "enrolled"]);
    expect(one.enrollmentId).not.toBe(two.enrollmentId);
  });
});

describe("getAutomationStats", () => {
  it("counts waiting enrollments per node and reads the shared send ledger by node key", async () => {
    const detail = await publishedAutomation();
    const automation = (await svc.findAutomationOr404(db, account.id, detail.id))!;
    const [alice] = await seedSubscribers(db, account.id, audience.id, ["alice@example.com"]);
    const { enrollmentId } = await svc.enrollByEmail(db, account, automation, alice.email, "manual");
    await db
      .update(automationEnrollments)
      .set({ currentNodeKey: "nd_send1" })
      .where(eq(automationEnrollments.id, enrollmentId!));

    const now = nowIso();
    const ledger = (status: "delivered" | "skipped" | "failed", extra: Partial<typeof campaignRecipients.$inferInsert> = {}) => ({
      id: newId("rcp"),
      campaignId: null,
      accountId: account.id,
      subscriberId: alice.id,
      email: alice.email,
      automationId: automation.id,
      automationEnrollmentId: enrollmentId!,
      automationNodeKey: "nd_send1",
      visitNo: 0,
      status,
      createdAt: now,
      updatedAt: now,
      ...extra,
    });
    await db.insert(campaignRecipients).values([
      ledger("delivered", { sentAt: now, deliveredAt: now, openedAt: now }),
      ledger("skipped", { visitNo: 1, error: "suppressed" }),
      ledger("skipped", { visitNo: 2, error: "too_stale" }),
      ledger("failed", { visitNo: 3, error: "bad address" }),
    ]);

    const stats = await svc.getAutomationStats(db, account.id, detail.id);
    expect(stats.counts.active).toBe(1);
    // Every draft node is present, zeros included.
    expect(stats.nodes.map((n) => n.nodeKey).sort()).toEqual(["nd_end", "nd_send1", "nd_trigger"]);
    const send = stats.nodes.find((n) => n.nodeKey === "nd_send1")!;
    expect(send).toMatchObject({
      waiting: 1,
      sent: 1,
      delivered: 1,
      opened: 1,
      clicked: 0,
      failed: 1,
      skipped: 2,
      skippedByReason: { suppressed: 1, too_stale: 1 },
    });
    expect(stats.nodes.find((n) => n.nodeKey === "nd_trigger")!.waiting).toBe(0);

    // Another account's ledger rows never leak in.
    const other = await seedAccount(db);
    await expect(svc.getAutomationStats(db, other.id, detail.id)).rejects.toMatchObject({ status: 404 });
  });
});

describe("sendAutomationNodeTest", () => {
  it("renders the draft send node with the automation's From identity and sends a [Test]", async () => {
    const detail = await publishedAutomation();
    const automation = (await svc.findAutomationOr404(db, account.id, detail.id))!;
    await svc.updateAutomationSettings(db, account, detail.id, { footerText: "Sent by the Welcome flow." });
    const fresh = (await svc.findAutomationOr404(db, account.id, detail.id))!;

    const result = await svc.sendAutomationNodeTest(db, account, fresh, "nd_send1", ["me@example.com"]);
    expect(result).toEqual({ sent: ["me@example.com"], failed: [] });
    expect(sends).toHaveLength(1);
    expect(sends[0].subject).toBe("[Test] Hello");
    expect(sends[0].fromEmail).toBe("news@updates.test.co");
    expect(sends[0].html).toContain("Welcome to the team.");
    expect(sends[0].html).toContain("Sent by the Welcome flow.");
    expect(sends[0].html).toContain("123 Test St");

    await expect(
      svc.sendAutomationNodeTest(db, account, automation, "nd_trigger", ["me@example.com"]),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.sendAutomationNodeTest(db, account, automation, "nd_nope", ["me@example.com"]),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("refuses an unconfigured step with a clear message", async () => {
    const created = await svc.createAutomation(db, account, { name: "W", audienceId: audience.id });
    await svc.saveDraftGraph(db, account, created.id, {
      nodes: [
        { key: "nd_trigger", kind: "trigger", config: {}, x: 0, y: 0 },
        { key: "nd_send1", kind: "send", config: { subject: "No body yet" }, x: 0, y: 100 },
      ],
      edges: [],
    });
    const automation = (await svc.findAutomationOr404(db, account.id, created.id))!;
    // Schema-valid but empty: the campaign test gate reports it.
    await expect(
      svc.sendAutomationNodeTest(db, account, automation, "nd_send1", ["me@example.com"]),
    ).rejects.toMatchObject({ status: 400 });
    expect(sends).toHaveLength(0);
  });
});

describe("tenant scoping", () => {
  it("never resolves another account's automation", async () => {
    const detail = await publishedAutomation();
    const other = await seedAccount(db);
    expect(await svc.getAutomationDetail(db, other.id, detail.id)).toBeNull();
    await expect(svc.pauseAutomation(db, other, detail.id)).rejects.toMatchObject({ status: 404 });
    await expect(svc.archiveAutomation(db, other, detail.id)).rejects.toMatchObject({ status: 404 });
    await expect(
      svc.listEnrollments(db, other.id, detail.id, { offset: 0, limit: 10 }),
    ).rejects.toMatchObject({ status: 404 });
    // Still there and untouched.
    const row = await db.query.automations.findFirst({
      where: and(eq(automations.id, detail.id), eq(automations.accountId, account.id)),
    });
    expect(row?.status).toBe("active");
  });
});
