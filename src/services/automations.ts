import { and, asc, desc, eq, getTableColumns, gte, inArray, ne, sql } from "drizzle-orm";
import { z } from "zod";
import { HttpError } from "../api/http";
import { ApiError } from "../api/v1/errors";
import { writeContacts } from "../api/v1/contacts";
import { cursorCondition, type PageCursor } from "../api/v1/pagination";
import type { Db } from "../db/client";
import {
  AUTOMATION_STATUSES,
  audiences,
  automationEdges,
  automationEnrollments,
  automationNodes,
  automationVersions,
  automations,
  campaignRecipients,
  forms,
  senders,
  sendingDomains,
  subscribers,
  topics,
  type Account,
  type Automation,
  type AutomationEnrollment,
  type Campaign,
} from "../db/schema";
import {
  AUTOMATION_NODE_KINDS,
  MAX_AUTOMATION_NODES,
  MAX_AUTOMATIONS_PER_ACCOUNT,
  NODE_PORTS,
  PORTS_BY_KIND,
  SendNodeConfigSchema,
  nodeTitle,
  validateGraph,
  type AutomationGraph,
  type GraphIssue,
  type GraphValidation,
} from "../lib/automation-graph";
import { buildTemplateGraph } from "../lib/automation-templates";
import type {
  AutomationDetail,
  AutomationListRow,
  AutomationReentryMode,
  AutomationStats,
  AutomationTriggerKind,
  CreateAutomationInput,
  DraftGraphInput,
  EnrollResult,
  EnrollmentCounts,
  EnrollmentPage,
  EnrollmentRow,
  EnrollmentStatus,
  GraphPayload,
  GraphPayloadNode,
  NodeStats,
  SendWindow,
} from "../lib/automation-types";
import { canonicalizeEmail, isValidEmail } from "../lib/csv";
import { newId, nowIso } from "../lib/ids";
import { MAX_SERIALIZED_BODY_CHARS, SectionsSchema, serializeSections } from "../lib/sections";
import { SegmentFilterSchema, safeParseSegmentFilter } from "../lib/segment-filter";
import { CampaignThemeSchema, resolveTheme, safeParseTheme } from "../lib/theme";
import { planCanSend, planSandboxMode } from "../lib/plans-catalog";
import { getQueue } from "../queue/producer";
import { enrollSubscriber, type EnrollSource } from "./automation-enroll";
import { sendCampaignTest, type TestSendResult } from "./campaign-send";
import { checkSendEligibility } from "./plans";
import { reviewCampaignRisk } from "./risk";

// The automation service: everything the session routes under /api/automations
// and the public v1 routes do to an automation, in one place. Same rule as
// services/campaign-send.ts: there are two front doors (the app and the API that
// the MCP server drives), and "which checks ran before this was published" may
// not have two answers, so every gate lives here and never in a route handler.
//
// Storage shape recap (docs/automations-design.md §2, §3): the `automations` row
// holds settings; the graph lives in per-version node/edge rows. The editor
// mutates the DRAFT version in place; publish freezes a copy as version N+1 and
// points new enrollments at it. Existing enrollments keep running on the version
// they entered on, so nothing here ever rewrites a published version.

/* ────────────────────────────── input schemas ─────────────────────────── */

// Mirrors the private NODE_KEY_RE in lib/automation-graph.ts (newId("nd") output).
// Re-declared rather than exported from there because the graph module is the
// pure model and this is a wire-level check on client-minted keys.
const NODE_KEY_RE = /^nd_[0-9a-z]{1,40}$/;
const NodeKeySchema = z.string().regex(NODE_KEY_RE, "Invalid node key");

const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3));
// `from` must come before `to` on the same day. The engine's clamp
// (automation-engine nextWindowOpen) can handle a window that wraps midnight,
// but the product only offers working-hours windows, and `from === to` would be
// an empty window the clamp has to ignore. Keep the input rule simple and
// explicit so a setting can never be stored that silently does nothing.
export const SendWindowSchema = z
  .object({
    days: z
      .array(z.number().int().min(0).max(6))
      .min(1)
      .max(7)
      .refine((days) => new Set(days).size === days.length, "Each day may appear only once"),
    from: z.string().regex(HHMM_RE, "Use HH:MM"),
    to: z.string().regex(HHMM_RE, "Use HH:MM"),
  })
  .strict()
  .refine((w) => minutesOf(w.from) < minutesOf(w.to), {
    message: "The window must end after it starts",
    path: ["to"],
  });

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

const optionalEmail = z.union([z.literal(""), z.email().toLowerCase()]).nullable();

export const CreateAutomationSchema = z.object({
  name: z.string().trim().min(1).max(150),
  audienceId: z.string().min(1).max(100),
  templateKey: z.string().max(60).nullable().optional(),
}) satisfies z.ZodType<CreateAutomationInput>;

// Every field optional; omitted means "leave alone", explicit null clears.
export const AutomationSettingsSchema = z
  .object({
    name: z.string().trim().min(1).max(150),
    triggerKind: z.enum(["audience_join", "api"]),
    triggerFormId: z.string().max(100).nullable(),
    entryFilter: SegmentFilterSchema.nullable(),
    exitFilter: SegmentFilterSchema.nullable(),
    reentry: z.enum(["once", "once_at_a_time", "always"]),
    senderId: z.string().max(100).nullable(),
    sendingDomainId: z.string().max(100).nullable(),
    fromName: z.string().trim().max(100).nullable(),
    fromEmail: optionalEmail,
    replyTo: optionalEmail,
    theme: CampaignThemeSchema.nullable(),
    footerText: z.string().trim().max(2_000).nullable(),
    topicId: z.string().max(100).nullable(),
    sendWindow: SendWindowSchema.nullable(),
    timezone: z.string().min(1).max(64).refine(isValidTimezone, "Unknown timezone"),
  })
  .partial();
export type AutomationSettingsInputParsed = z.infer<typeof AutomationSettingsSchema>;

export const DraftGraphSchema = z.object({
  nodes: z
    .array(
      z.object({
        key: NodeKeySchema,
        kind: z.enum(AUTOMATION_NODE_KINDS),
        config: z.unknown(),
        label: z.string().max(200).nullable().optional(),
        x: z.number().int().min(-1_000_000).max(1_000_000),
        y: z.number().int().min(-1_000_000).max(1_000_000),
      }),
    )
    .max(MAX_AUTOMATION_NODES, `An automation can have at most ${MAX_AUTOMATION_NODES} nodes`),
  edges: z
    .array(z.object({ fromKey: NodeKeySchema, port: z.enum(NODE_PORTS), toKey: NodeKeySchema }))
    .max(MAX_AUTOMATION_NODES * 2),
}) satisfies z.ZodType<DraftGraphInput>;

// What the client may author on a send node. Deliberately NOT SendNodeConfigSchema:
// a draft may be half-edited, and htmlBody is never accepted from the client (it
// is derived from sectionsJson below, exactly as PATCH /api/campaigns/[id] does),
// so the send-authoritative body can never drift from the structure the builder
// edits and is email-safe by construction. Unknown keys (a stale htmlBody) drop.
const SendNodeDraftSchema = z.object({
  subject: z.string().max(500).default(""),
  previewText: z.string().max(500).nullable().default(null),
  sectionsJson: z.string().max(MAX_SERIALIZED_BODY_CHARS).nullable().default(null),
  textBody: z.string().max(MAX_SERIALIZED_BODY_CHARS).nullable().default(null),
  allowResend: z.boolean().default(false),
});

// Every other kind's config is small by construction (a wait is two fields, a
// branch filter is at most ten conditions of 500 chars), but a draft stores it
// as opaque JSON because it may be half-edited. Without a ceiling a client could
// park megabytes under a wait node and have them served back on every detail
// read, so bound it well above anything the canvas can produce.
const MAX_NODE_CONFIG_CHARS = 20_000;

/* ─────────────────────────────── lookups ──────────────────────────────── */

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbLike = Db | Tx;

export async function findAutomation(
  db: Db,
  accountId: string,
  id: string,
): Promise<Automation | undefined> {
  return db.query.automations.findFirst({
    where: and(eq(automations.id, id), eq(automations.accountId, accountId)),
  });
}

export async function findAutomationOr404(db: Db, accountId: string, id: string): Promise<Automation> {
  const automation = await findAutomation(db, accountId, id);
  if (!automation) throw new HttpError(404, "Automation not found");
  return automation;
}

function assertNotArchived(automation: Automation): void {
  if (automation.status === "archived") {
    throw new HttpError(409, "This automation has been archived and can no longer be changed.");
  }
}

// The account's default From identity, the way the composer pre-selects one:
// the sender flagged default, else the first one. Null when the account has no
// senders yet, which is fine for a draft (publish is the gate that needs one).
async function defaultSender(db: DbLike, accountId: string) {
  const rows = await db.select().from(senders).where(eq(senders.accountId, accountId));
  return rows.find((s) => s.isDefault) ?? rows[0] ?? null;
}

/* ─────────────────────────────── the graph ────────────────────────────── */

function parseConfig(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}

function parseGuidance(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((g): g is string => typeof g === "string") : null;
  } catch {
    return null;
  }
}

async function loadGraph(db: DbLike, accountId: string, versionId: string): Promise<GraphPayload> {
  const [nodeRows, edgeRows] = await Promise.all([
    db
      .select()
      .from(automationNodes)
      .where(and(eq(automationNodes.automationVersionId, versionId), eq(automationNodes.accountId, accountId)))
      .orderBy(asc(automationNodes.canvasY), asc(automationNodes.canvasX), asc(automationNodes.key)),
    db
      .select()
      .from(automationEdges)
      .where(and(eq(automationEdges.automationVersionId, versionId), eq(automationEdges.accountId, accountId)))
      .orderBy(asc(automationEdges.fromNodeKey), asc(automationEdges.port)),
  ]);
  return {
    nodes: nodeRows.map(
      (n): GraphPayloadNode => ({
        key: n.key,
        kind: n.kind,
        config: parseConfig(n.configJson),
        label: n.label,
        x: n.canvasX,
        y: n.canvasY,
        risk: n.riskLevel
          ? { level: n.riskLevel, summary: n.riskSummary, guidance: parseGuidance(n.riskGuidanceJson) }
          : null,
      }),
    ),
    edges: edgeRows.map((e) => ({
      fromKey: e.fromNodeKey,
      port: e.port as GraphPayload["edges"][number]["port"],
      toKey: e.toNodeKey,
    })),
  };
}

export function toGraph(payload: GraphPayload): AutomationGraph {
  return {
    nodes: payload.nodes.map((n) => ({ key: n.key, kind: n.kind, config: n.config, label: n.label })),
    edges: payload.edges.map((e) => ({ fromKey: e.fromKey, port: e.port, toKey: e.toKey })),
  };
}

// Key-sorted JSON so two configs that differ only in property order compare equal.
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

// What "the draft differs from what is live" means: kinds, configs, labels and
// wiring. Coordinates are presentation, and moving a node around must not light
// up the Publish button.
function graphFingerprint(payload: GraphPayload): string {
  const nodes = [...payload.nodes]
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .map((n) => ({ key: n.key, kind: n.kind, config: n.config, label: n.label ?? null }));
  const edges = [...payload.edges]
    .map((e) => `${e.fromKey}|${e.port}|${e.toKey}`)
    .sort();
  return canonicalJson({ nodes, edges });
}

/* ─────────────────────────────── counts ───────────────────────────────── */

const EMPTY_COUNTS = (): EnrollmentCounts => ({
  active: 0,
  sending: 0,
  completed: 0,
  exited: 0,
  failed: 0,
  total: 0,
});

// One grouped query for any number of automations; the list page and the detail
// page share it so the two never count differently.
export async function enrollmentCountsByAutomation(
  db: Db,
  accountId: string,
  automationIds: string[],
): Promise<Map<string, EnrollmentCounts>> {
  const out = new Map<string, EnrollmentCounts>();
  if (automationIds.length === 0) return out;
  const rows = await db
    .select({
      automationId: automationEnrollments.automationId,
      status: automationEnrollments.status,
      count: sql<number>`count(*)::int`.as("count"),
    })
    .from(automationEnrollments)
    .where(
      and(
        eq(automationEnrollments.accountId, accountId),
        inArray(automationEnrollments.automationId, automationIds),
      ),
    )
    .groupBy(automationEnrollments.automationId, automationEnrollments.status);
  for (const row of rows) {
    const counts = out.get(row.automationId) ?? EMPTY_COUNTS();
    const n = Number(row.count);
    counts[row.status] += n;
    counts.total += n;
    out.set(row.automationId, counts);
  }
  return out;
}

/* ─────────────────────────────── detail ───────────────────────────────── */

function parseSendWindow(json: string | null): SendWindow | null {
  if (!json) return null;
  try {
    const parsed = SendWindowSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

// The draft is version 0 for the life of the automation: it is never published
// as itself (publish copies it), so giving it a number in the sequence would make
// the first publish read as "v2". Published versions count from 1.
const DRAFT_VERSION_NUMBER = 0;

// Every draft must have a version row to hang nodes on. Created with the
// automation; this only fills the gap for a row that somehow lost it, so the
// editor never has to special-case "no draft yet".
async function ensureDraftVersionId(db: Db, automation: Automation): Promise<string> {
  if (automation.draftVersionId) return automation.draftVersionId;
  const now = nowIso();
  const id = newId("aev");
  await db.insert(automationVersions).values({
    id,
    accountId: automation.accountId,
    automationId: automation.id,
    version: DRAFT_VERSION_NUMBER,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  });
  await db
    .update(automations)
    .set({ draftVersionId: id, updatedAt: now })
    .where(eq(automations.id, automation.id));
  automation.draftVersionId = id;
  return id;
}

async function nextVersionNumber(db: DbLike, automationId: string): Promise<number> {
  const [row] = await db
    .select({ max: sql<number>`coalesce(max(${automationVersions.version}), 0)::int` })
    .from(automationVersions)
    .where(eq(automationVersions.automationId, automationId));
  return Number(row?.max ?? 0) + 1;
}

export async function getAutomationDetail(
  db: Db,
  accountId: string,
  id: string,
): Promise<AutomationDetail | null> {
  const automation = await findAutomation(db, accountId, id);
  if (!automation) return null;
  return buildDetail(db, automation);
}

async function buildDetail(db: Db, automation: Automation): Promise<AutomationDetail> {
  const draftVersionId = await ensureDraftVersionId(db, automation);
  const [audience, draft, liveVersion, countsById] = await Promise.all([
    db.query.audiences.findFirst({
      where: and(eq(audiences.id, automation.audienceId), eq(audiences.accountId, automation.accountId)),
    }),
    loadGraph(db, automation.accountId, draftVersionId),
    automation.liveVersionId
      ? db.query.automationVersions.findFirst({
          where: and(
            eq(automationVersions.id, automation.liveVersionId),
            eq(automationVersions.accountId, automation.accountId),
          ),
        })
      : Promise.resolve(undefined),
    enrollmentCountsByAutomation(db, automation.accountId, [automation.id]),
  ]);
  const live = liveVersion ? await loadGraph(db, automation.accountId, liveVersion.id) : null;
  const theme = safeParseTheme(automation.themeJson);

  return {
    id: automation.id,
    name: automation.name,
    status: automation.status,
    audienceId: automation.audienceId,
    audienceName: audience?.name ?? "",
    triggerKind: automation.triggerKind as AutomationTriggerKind,
    triggerFormId: automation.triggerFormId,
    entryFilter: automation.entryFilterJson ? safeParseSegmentFilter(automation.entryFilterJson) : null,
    exitFilter: automation.exitFilterJson ? safeParseSegmentFilter(automation.exitFilterJson) : null,
    reentry: automation.reentry as AutomationReentryMode,
    senderId: automation.senderId,
    sendingDomainId: automation.sendingDomainId,
    fromName: automation.fromName,
    fromEmail: automation.fromEmail,
    replyTo: automation.replyTo,
    theme: theme ? resolveTheme(theme) : null,
    footerText: automation.footerText,
    topicId: automation.topicId,
    sendWindow: parseSendWindow(automation.sendWindowJson),
    timezone: automation.timezone,
    sandbox: automation.sandbox,
    liveVersion: liveVersion
      ? { id: liveVersion.id, version: liveVersion.version, publishedAt: liveVersion.publishedAt }
      : null,
    draftVersionId,
    draft,
    live,
    // Nothing live yet means everything in the draft is unpublished.
    draftDirty: live ? graphFingerprint(draft) !== graphFingerprint(live) : true,
    validation: validateGraph(toGraph(draft)),
    counts: countsById.get(automation.id) ?? EMPTY_COUNTS(),
    createdAt: automation.createdAt,
    updatedAt: automation.updatedAt,
  };
}

/* ─────────────────────────────── create ───────────────────────────────── */

// Write a graph's rows under a version. Chunked well under the 65535 bound
// parameter cap; a 100-node graph is one statement each in practice.
async function insertGraphRows(
  tx: DbLike,
  accountId: string,
  versionId: string,
  graph: {
    nodes: {
      key: string;
      kind: GraphPayloadNode["kind"];
      config: unknown;
      label?: string | null;
      x: number;
      y: number;
      risk?: { level: string; summary: string | null; guidance: string[] | null } | null;
    }[];
    edges: DraftGraphInput["edges"];
  },
  now: string,
): Promise<void> {
  const nodeRows = graph.nodes.map((n) => ({
    id: newId("aun"),
    accountId,
    automationVersionId: versionId,
    key: n.key,
    kind: n.kind,
    configJson: JSON.stringify(n.config ?? {}),
    label: n.label ?? null,
    canvasX: n.x,
    canvasY: n.y,
    riskLevel: n.risk?.level ?? null,
    riskSummary: n.risk?.summary ?? null,
    riskGuidanceJson: n.risk?.guidance && n.risk.guidance.length > 0 ? JSON.stringify(n.risk.guidance) : null,
    createdAt: now,
    updatedAt: now,
  }));
  for (let i = 0; i < nodeRows.length; i += 200) {
    await tx.insert(automationNodes).values(nodeRows.slice(i, i + 200));
  }
  const edgeRows = graph.edges.map((e) => ({
    id: newId("aee"),
    accountId,
    automationVersionId: versionId,
    fromNodeKey: e.fromKey,
    port: e.port,
    toNodeKey: e.toKey,
    createdAt: now,
  }));
  for (let i = 0; i < edgeRows.length; i += 500) {
    await tx.insert(automationEdges).values(edgeRows.slice(i, i + 500));
  }
}

export async function createAutomation(
  db: Db,
  account: Account,
  input: CreateAutomationInput,
): Promise<AutomationDetail> {
  const audience = await db.query.audiences.findFirst({
    where: and(eq(audiences.id, input.audienceId), eq(audiences.accountId, account.id)),
  });
  if (!audience) throw new HttpError(400, "Audience not found");

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(automations)
    .where(and(eq(automations.accountId, account.id), ne(automations.status, "archived")));
  if (Number(count) >= MAX_AUTOMATIONS_PER_ACCOUNT) {
    throw new HttpError(
      400,
      `An account can have at most ${MAX_AUTOMATIONS_PER_ACCOUNT} automations. Archive one you no longer use first.`,
    );
  }

  let graph: DraftGraphInput;
  if (input.templateKey) {
    const built = buildTemplateGraph(input.templateKey);
    if (!built) throw new HttpError(400, "Unknown template");
    graph = built;
  } else {
    graph = { nodes: [{ key: newId("nd"), kind: "trigger", config: {}, label: null, x: 0, y: 0 }], edges: [] };
  }

  const sender = await defaultSender(db, account.id);
  const now = nowIso();
  const id = newId("aut");
  const versionId = newId("aev");

  await db.transaction(async (tx) => {
    await tx.insert(automations).values({
      id,
      accountId: account.id,
      audienceId: audience.id,
      name: input.name,
      status: "draft",
      triggerKind: "audience_join",
      reentry: "once",
      senderId: sender?.id ?? null,
      sendingDomainId: sender?.sendingDomainId ?? null,
      fromName: sender?.fromName ?? null,
      fromEmail: sender?.fromEmail ?? null,
      replyTo: sender?.replyTo ?? null,
      timezone: "UTC",
      sandbox: false,
      liveVersionId: null,
      draftVersionId: versionId,
      createdAt: now,
      updatedAt: now,
    });
    await tx.insert(automationVersions).values({
      id: versionId,
      accountId: account.id,
      automationId: id,
      version: DRAFT_VERSION_NUMBER,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    });
    await insertGraphRows(tx, account.id, versionId, graph, now);
  });

  return (await getAutomationDetail(db, account.id, id))!;
}

/* ─────────────────────────────── settings ─────────────────────────────── */

export async function updateAutomationSettings(
  db: Db,
  account: Account,
  id: string,
  input: AutomationSettingsInputParsed,
): Promise<AutomationDetail> {
  const automation = await findAutomationOr404(db, account.id, id);
  assertNotArchived(automation);

  const set: Partial<typeof automations.$inferInsert> = { updatedAt: nowIso() };

  if (input.name !== undefined) set.name = input.name;
  if (input.triggerKind !== undefined) set.triggerKind = input.triggerKind;
  if (input.reentry !== undefined) set.reentry = input.reentry;
  if (input.entryFilter !== undefined) {
    set.entryFilterJson = input.entryFilter ? JSON.stringify(input.entryFilter) : null;
  }
  if (input.exitFilter !== undefined) {
    set.exitFilterJson = input.exitFilter ? JSON.stringify(input.exitFilter) : null;
  }
  if (input.theme !== undefined) set.themeJson = input.theme ? JSON.stringify(input.theme) : null;
  if (input.footerText !== undefined) set.footerText = input.footerText || null;
  if (input.sendWindow !== undefined) {
    set.sendWindowJson = input.sendWindow ? JSON.stringify(input.sendWindow) : null;
  }
  if (input.timezone !== undefined) set.timezone = input.timezone;

  // A narrowing form or topic must belong to this account AND this audience: a
  // form on audience A must not gate enrollment into an automation on audience B.
  if (input.triggerFormId !== undefined) {
    if (input.triggerFormId) {
      const form = await db.query.forms.findFirst({
        where: and(eq(forms.id, input.triggerFormId), eq(forms.accountId, account.id)),
      });
      if (!form || form.audienceId !== automation.audienceId) {
        throw new HttpError(400, "Form not found on this audience");
      }
    }
    set.triggerFormId = input.triggerFormId || null;
  }
  if (input.topicId !== undefined) {
    if (input.topicId) {
      const topic = await db.query.topics.findFirst({
        where: and(eq(topics.id, input.topicId), eq(topics.accountId, account.id)),
      });
      if (!topic || topic.audienceId !== automation.audienceId) {
        throw new HttpError(400, "Topic not found on this audience");
      }
    }
    set.topicId = input.topicId || null;
  }

  // From identity, resolved exactly as campaigns do it: a sender wins and fills
  // every field; without one, the individual fields are taken as given but must
  // still agree with a domain this account owns.
  if (input.senderId) {
    const sender = await db.query.senders.findFirst({
      where: and(eq(senders.id, input.senderId), eq(senders.accountId, account.id)),
    });
    if (!sender) throw new HttpError(400, "Sender not found");
    set.senderId = sender.id;
    set.sendingDomainId = sender.sendingDomainId;
    set.fromName = input.fromName !== undefined && input.fromName !== null ? input.fromName : sender.fromName;
    set.fromEmail = sender.fromEmail;
    set.replyTo = input.replyTo !== undefined ? input.replyTo || null : sender.replyTo;
  } else {
    if (input.senderId === null) set.senderId = null;
    if (input.sendingDomainId !== undefined) {
      if (input.sendingDomainId) {
        const domain = await db.query.sendingDomains.findFirst({
          where: and(eq(sendingDomains.id, input.sendingDomainId), eq(sendingDomains.accountId, account.id)),
        });
        if (!domain) throw new HttpError(400, "Sending domain not found");
      }
      set.sendingDomainId = input.sendingDomainId || null;
    }
    if (input.fromName !== undefined) set.fromName = input.fromName || null;
    if (input.fromEmail !== undefined) set.fromEmail = input.fromEmail || null;
    if (input.replyTo !== undefined) set.replyTo = input.replyTo || null;

    const domainId = set.sendingDomainId !== undefined ? set.sendingDomainId : automation.sendingDomainId;
    const fromEmail = set.fromEmail !== undefined ? set.fromEmail : automation.fromEmail;
    if (domainId && fromEmail) {
      const domain = await db.query.sendingDomains.findFirst({
        where: and(eq(sendingDomains.id, domainId), eq(sendingDomains.accountId, account.id)),
      });
      if (domain && !fromEmail.endsWith(`@${domain.domain}`)) {
        throw new HttpError(400, "From email must use the selected sending domain");
      }
    }
  }

  await db
    .update(automations)
    .set(set)
    .where(and(eq(automations.id, automation.id), eq(automations.accountId, account.id)));
  return (await getAutomationDetail(db, account.id, automation.id))!;
}

/* ──────────────────────────────── draft ───────────────────────────────── */

// Normalize an incoming draft: structural checks that would otherwise surface as
// a unique-index violation or a nonsense edge, plus the server-side derivation
// of every send node's htmlBody. Configs are NOT required to be valid here (a
// draft may be half-edited); validateGraph on the next read reports what is
// missing. Returns the graph as it will be stored.
function prepareDraft(input: DraftGraphInput): DraftGraphInput {
  const seen = new Set<string>();
  const kinds = new Map<string, GraphPayloadNode["kind"]>();
  for (const node of input.nodes) {
    if (seen.has(node.key)) throw new HttpError(400, `Two steps share the id ${node.key}`);
    seen.add(node.key);
    kinds.set(node.key, node.kind);
  }
  const ports = new Set<string>();
  for (const edge of input.edges) {
    const kind = kinds.get(edge.fromKey);
    if (kind && !PORTS_BY_KIND[kind].includes(edge.port)) {
      throw new HttpError(400, `A "${kind}" step has no "${edge.port}" output`);
    }
    const portKey = `${edge.fromKey}:${edge.port}`;
    if (ports.has(portKey)) {
      throw new HttpError(400, "A step has two connections from the same output");
    }
    ports.add(portKey);
  }

  const nodes = input.nodes.map((node, index) => {
    if (node.kind !== "send") {
      if (JSON.stringify(node.config ?? {}).length > MAX_NODE_CONFIG_CHARS) {
        throw new HttpError(400, `Step ${index + 1} has too much configuration data`);
      }
      return { ...node, label: node.label ?? null };
    }
    const parsed = SendNodeDraftSchema.safeParse(node.config ?? {});
    if (!parsed.success) {
      throw new HttpError(400, `Email step ${index + 1} has invalid content`);
    }
    const draft = parsed.data;
    let htmlBody = "";
    let sectionsJson: string | null = null;
    if (draft.sectionsJson) {
      let raw: unknown;
      try {
        raw = JSON.parse(draft.sectionsJson);
      } catch {
        throw new HttpError(400, `Email step ${index + 1} has invalid content`);
      }
      const sections = SectionsSchema.safeParse(raw);
      if (!sections.success) {
        throw new HttpError(400, `Email step ${index + 1} has invalid content`);
      }
      htmlBody = serializeSections(sections.data);
      sectionsJson = JSON.stringify(sections.data);
    }
    return {
      ...node,
      label: node.label ?? null,
      config: { ...draft, sectionsJson, htmlBody },
    };
  });

  return { nodes, edges: input.edges };
}

export async function saveDraftGraph(
  db: Db,
  account: Account,
  id: string,
  input: DraftGraphInput,
): Promise<AutomationDetail> {
  const automation = await findAutomationOr404(db, account.id, id);
  assertNotArchived(automation);
  if (input.nodes.length > MAX_AUTOMATION_NODES) {
    throw new HttpError(400, `An automation can have at most ${MAX_AUTOMATION_NODES} nodes`);
  }
  const graph = prepareDraft(input);
  const versionId = await ensureDraftVersionId(db, automation);
  const now = nowIso();

  // Replace rather than diff: the draft is small, the client sends the whole
  // canvas, and a wholesale swap inside one transaction cannot leave a node
  // pointing at an edge that was deleted a statement earlier.
  await db.transaction(async (tx) => {
    await tx
      .delete(automationEdges)
      .where(and(eq(automationEdges.automationVersionId, versionId), eq(automationEdges.accountId, account.id)));
    await tx
      .delete(automationNodes)
      .where(and(eq(automationNodes.automationVersionId, versionId), eq(automationNodes.accountId, account.id)));
    await insertGraphRows(tx, account.id, versionId, graph, now);
    await tx.update(automationVersions).set({ updatedAt: now }).where(eq(automationVersions.id, versionId));
    await tx.update(automations).set({ updatedAt: now }).where(eq(automations.id, automation.id));
  });

  return (await getAutomationDetail(db, account.id, automation.id))!;
}

/* ─────────────────────────────── publish ──────────────────────────────── */

export type PublishResult =
  | { ok: true; detail: AutomationDetail }
  | { ok: false; error: string; validation: GraphValidation };

const PUBLISH_BLOCKED = "Fix the issues below before publishing.";

export async function publishAutomation(
  db: Db,
  account: Account,
  id: string,
  publishedBy: string,
): Promise<PublishResult> {
  const automation = await findAutomationOr404(db, account.id, id);
  assertNotArchived(automation);
  const draftVersionId = await ensureDraftVersionId(db, automation);
  const draft = await loadGraph(db, account.id, draftVersionId);

  const validation = validateGraph(toGraph(draft));
  const errors: GraphIssue[] = [...validation.errors];
  const gate = (message: string) => errors.push({ code: "invalid_config", message });

  // The same gates a campaign passes at submit (services/campaign-send.ts
  // assertSendable): a From identity on a verified domain, and the mailing
  // address the law requires in every email. Reported in the validation shape
  // so the canvas shows them in the same list as graph problems.
  const domain = automation.sendingDomainId
    ? await db.query.sendingDomains.findFirst({
        where: and(
          eq(sendingDomains.id, automation.sendingDomainId),
          eq(sendingDomains.accountId, account.id),
        ),
      })
    : undefined;
  if (!automation.fromEmail?.trim() || !automation.sendingDomainId) {
    gate("Choose a From address in the automation's settings before publishing.");
  } else if (!domain || !(domain.verificationStatus === "verified" || domain.adminOverrideVerified)) {
    gate("Verify your sending domain before publishing. Email can only go out from a verified domain.");
  } else if (!automation.fromEmail.trim().toLowerCase().endsWith(`@${domain.domain.toLowerCase()}`)) {
    // Settings keep these aligned on every write, but the two columns are
    // independent and a sender's row can be edited after it was snapshotted
    // here. SES would refuse the send anyway; fail at publish, with a fix.
    gate("The From address must use the selected sending domain. Pick a sender on that domain in the settings.");
  }
  if (!account.companyAddress?.trim()) {
    gate("Add your business mailing address in Settings before publishing. It is legally required in every email.");
  }

  // Account eligibility is the same function a campaign submit runs
  // (billing, risk pause, allowance), so "can this account send?" has one
  // answer whichever surface asks. Then the plan gate on top: the free tier
  // publishes in sandbox mode (org members only, shared allowance) rather than
  // being blocked, matching campaigns, while an unrecognized plan fails closed.
  // planSandboxMode is deliberately not !planCanSend, and this check is kept
  // even though eligibility passed because eligibility reads sendingEnabled,
  // which does not know the plan catalogue.
  const eligibility = checkSendEligibility(account);
  if (!eligibility.allowed) gate(eligibility.reason);
  const sandbox = planSandboxMode(account.plan);
  if (!planCanSend(account.plan) && !sandbox) {
    gate("Your plan cannot send email. Upgrade to publish this automation.");
  }

  if (errors.length > 0) {
    return { ok: false, error: PUBLISH_BLOCKED, validation: { errors, warnings: validation.warnings, ok: false } };
  }

  // Risk review per send node, at publish: content is fixed and sends are
  // open-ended, so this is the one moment the review can run. Same two-pass
  // review (deterministic floor, escalate-only AI) a campaign gets. `high` or
  // `blocked` stops the publish with the node's own fix-it guidance; anything
  // lower is recorded on the published node rows for the canvas to show.
  const risks = new Map<string, { level: string; summary: string | null; guidance: string[] | null }>();
  for (const node of draft.nodes) {
    if (node.kind !== "send") continue;
    const config = SendNodeConfigSchema.parse(node.config ?? {});
    const review = await reviewCampaignRisk(
      {
        subject: config.subject,
        htmlBody: config.htmlBody,
        textBody: config.textBody,
        fromEmail: automation.fromEmail ?? "",
        sendingDomain: domain?.domain ?? "",
      },
      process.env.AI_REVIEW_MODE,
    );
    risks.set(node.key, {
      level: review.riskLevel,
      summary: review.summary,
      guidance: review.guidance.length > 0 ? review.guidance : null,
    });
    if (review.riskLevel === "high" || review.riskLevel === "blocked") {
      const fixes = review.guidance.length > 0 ? ` ${review.guidance.join(" ")}` : "";
      errors.push({
        code: "invalid_config",
        message: `${nodeTitle({ key: node.key, kind: node.kind, config: node.config, label: node.label })} did not pass the safety review.${fixes}`,
        nodeKey: node.key,
      });
    }
  }
  if (errors.length > 0) {
    return { ok: false, error: PUBLISH_BLOCKED, validation: { errors, warnings: validation.warnings, ok: false } };
  }

  const now = nowIso();
  const newVersionId = newId("aev");
  await db.transaction(async (tx) => {
    const version = await nextVersionNumber(tx, automation.id);
    // Two publishes racing each other both read the same max and both try to
    // insert N+1. The unique index on (automation, version) refuses the loser;
    // letting that surface as a raw constraint error would be a 500 for what is
    // really "someone got there first", so the insert is made conflict-aware
    // and the loser gets a 409. Throwing here rolls the transaction back.
    const inserted = await tx
      .insert(automationVersions)
      .values({
        id: newVersionId,
        accountId: account.id,
        automationId: automation.id,
        version,
        status: "published",
        publishedAt: now,
        publishedBy,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning({ id: automationVersions.id });
    if (inserted.length === 0) {
      throw new HttpError(409, "This automation was published a moment ago by someone else. Refresh and try again.");
    }
    // A verbatim copy of the draft with new row ids and the same keys, so
    // enrollments pinned to earlier versions and stats keyed by node key both
    // keep resolving. The draft rows themselves are untouched: the editor keeps
    // editing the same version id it had.
    await insertGraphRows(
      tx,
      account.id,
      newVersionId,
      {
        nodes: draft.nodes.map((n) => ({ ...n, risk: risks.get(n.key) ?? null })),
        edges: draft.edges,
      },
      now,
    );
    // Supersede whatever is currently published rather than the one live id
    // this call remembered: a publish that landed between our read and this
    // transaction would otherwise stay "published" forever beside the new one.
    await tx
      .update(automationVersions)
      .set({ status: "superseded", updatedAt: now })
      .where(
        and(
          eq(automationVersions.automationId, automation.id),
          eq(automationVersions.accountId, account.id),
          eq(automationVersions.status, "published"),
          ne(automationVersions.id, newVersionId),
        ),
      );
    // Publishing while paused keeps the pause: the user chose to stop enrollment
    // and a content edit is not consent to resume.
    await tx
      .update(automations)
      .set({
        liveVersionId: newVersionId,
        status: automation.status === "paused" ? "paused" : "active",
        sandbox,
        updatedAt: now,
      })
      .where(eq(automations.id, automation.id));
  });

  return { ok: true, detail: (await getAutomationDetail(db, account.id, automation.id))! };
}

/* ─────────────────────────── pause / resume / archive ─────────────────── */

// Pausing only flips the row; the engine reads automations.status before every
// tick and the enroll gate refuses a paused automation, so nothing else is needed.
export async function pauseAutomation(db: Db, account: Account, id: string): Promise<AutomationDetail> {
  const automation = await findAutomationOr404(db, account.id, id);
  if (automation.status !== "active") {
    throw new HttpError(409, `An automation with status "${automation.status}" cannot be paused.`);
  }
  await db
    .update(automations)
    .set({ status: "paused", updatedAt: nowIso() })
    .where(eq(automations.id, automation.id));
  return (await getAutomationDetail(db, account.id, automation.id))!;
}

export async function resumeAutomation(db: Db, account: Account, id: string): Promise<AutomationDetail> {
  const automation = await findAutomationOr404(db, account.id, id);
  if (automation.status !== "paused") {
    throw new HttpError(409, `An automation with status "${automation.status}" cannot be resumed.`);
  }
  const now = nowIso();
  await db
    .update(automations)
    .set({ status: "active", updatedAt: now })
    .where(eq(automations.id, automation.id));
  // Enrollments that reached a send node while paused are holding with a
  // 5-minute recheck (engine PAUSED_RETRY_MS). Make them due now so "Resume"
  // visibly resumes; the next tick picks them up within a minute.
  await db
    .update(automationEnrollments)
    .set({ nextRunAt: now, updatedAt: now })
    .where(
      and(
        eq(automationEnrollments.automationId, automation.id),
        eq(automationEnrollments.accountId, account.id),
        eq(automationEnrollments.status, "active"),
        eq(automationEnrollments.holdReason, "automation_paused"),
      ),
    );
  return (await getAutomationDetail(db, account.id, automation.id))!;
}

// Archive is the delete: live enrollments exit (reason automation_archived) and
// the row stays for its history. A draft that was never published and never
// enrolled anyone has no history to keep, so it is removed outright.
export async function archiveAutomation(db: Db, account: Account, id: string): Promise<void> {
  const automation = await findAutomationOr404(db, account.id, id);
  const now = nowIso();

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(automationEnrollments)
    .where(
      and(eq(automationEnrollments.automationId, automation.id), eq(automationEnrollments.accountId, account.id)),
    );

  if (!automation.liveVersionId && Number(count) === 0) {
    await db.transaction(async (tx) => {
      const versionIds = (
        await tx
          .select({ id: automationVersions.id })
          .from(automationVersions)
          .where(
            and(eq(automationVersions.automationId, automation.id), eq(automationVersions.accountId, account.id)),
          )
      ).map((v) => v.id);
      if (versionIds.length > 0) {
        await tx
          .delete(automationEdges)
          .where(and(inArray(automationEdges.automationVersionId, versionIds), eq(automationEdges.accountId, account.id)));
        await tx
          .delete(automationNodes)
          .where(and(inArray(automationNodes.automationVersionId, versionIds), eq(automationNodes.accountId, account.id)));
        await tx.delete(automationVersions).where(inArray(automationVersions.id, versionIds));
      }
      await tx.delete(automations).where(eq(automations.id, automation.id));
    });
    return;
  }

  await db.transaction(async (tx) => {
    await tx
      .update(automations)
      .set({ status: "archived", updatedAt: now })
      .where(eq(automations.id, automation.id));
    await tx
      .update(automationEnrollments)
      .set({ status: "exited", exitReason: "automation_archived", exitedAt: now, updatedAt: now })
      .where(
        and(
          eq(automationEnrollments.automationId, automation.id),
          eq(automationEnrollments.accountId, account.id),
          inArray(automationEnrollments.status, ["active", "sending"]),
        ),
      );
  });
}

/* ──────────────────────────────── stats ───────────────────────────────── */

export async function getAutomationStats(db: Db, accountId: string, id: string): Promise<AutomationStats> {
  const automation = await findAutomationOr404(db, accountId, id);
  const draftVersionId = await ensureDraftVersionId(db, automation);

  const [countsById, waitingRows, ledgerRows, skipRows, draft] = await Promise.all([
    enrollmentCountsByAutomation(db, accountId, [automation.id]),
    db
      .select({ nodeKey: automationEnrollments.currentNodeKey, count: sql<number>`count(*)::int` })
      .from(automationEnrollments)
      .where(
        and(
          eq(automationEnrollments.automationId, automation.id),
          eq(automationEnrollments.accountId, accountId),
          inArray(automationEnrollments.status, ["active", "sending"]),
        ),
      )
      .groupBy(automationEnrollments.currentNodeKey),
    // The shared send ledger, this automation's rows only. Counters come off the
    // stamped timestamps rather than the status column, because a row that was
    // opened is still status `delivered`: the status is a lifecycle, the
    // timestamps are the facts the canvas reports.
    db
      .select({
        nodeKey: campaignRecipients.automationNodeKey,
        sent: sql<number>`count(*) filter (where ${campaignRecipients.sentAt} is not null)::int`,
        delivered: sql<number>`count(*) filter (where ${campaignRecipients.deliveredAt} is not null)::int`,
        opened: sql<number>`count(*) filter (where ${campaignRecipients.openedAt} is not null)::int`,
        clicked: sql<number>`count(*) filter (where ${campaignRecipients.clickedAt} is not null)::int`,
        bounced: sql<number>`count(*) filter (where ${campaignRecipients.bouncedAt} is not null or ${campaignRecipients.status} = 'bounced')::int`,
        complained: sql<number>`count(*) filter (where ${campaignRecipients.complainedAt} is not null or ${campaignRecipients.status} = 'complained')::int`,
        unsubscribed: sql<number>`count(*) filter (where ${campaignRecipients.unsubscribedAt} is not null or ${campaignRecipients.status} = 'unsubscribed')::int`,
        failed: sql<number>`count(*) filter (where ${campaignRecipients.status} = 'failed')::int`,
        skipped: sql<number>`count(*) filter (where ${campaignRecipients.status} = 'skipped')::int`,
      })
      .from(campaignRecipients)
      .where(and(eq(campaignRecipients.automationId, automation.id), eq(campaignRecipients.accountId, accountId)))
      .groupBy(campaignRecipients.automationNodeKey),
    db
      .select({
        nodeKey: campaignRecipients.automationNodeKey,
        reason: campaignRecipients.error,
        count: sql<number>`count(*)::int`,
      })
      .from(campaignRecipients)
      .where(
        and(
          eq(campaignRecipients.automationId, automation.id),
          eq(campaignRecipients.accountId, accountId),
          eq(campaignRecipients.status, "skipped"),
        ),
      )
      .groupBy(campaignRecipients.automationNodeKey, campaignRecipients.error),
    loadGraph(db, accountId, draftVersionId),
  ]);

  const byKey = new Map<string, NodeStats>();
  const statsFor = (key: string): NodeStats => {
    let s = byKey.get(key);
    if (!s) {
      s = {
        nodeKey: key,
        waiting: 0,
        sent: 0,
        delivered: 0,
        opened: 0,
        clicked: 0,
        bounced: 0,
        complained: 0,
        unsubscribed: 0,
        failed: 0,
        skipped: 0,
        skippedByReason: {},
      };
      byKey.set(key, s);
    }
    return s;
  };
  // Every node on the canvas gets a row, zeros included, so the badges never
  // have to special-case "no data yet".
  for (const node of draft.nodes) statsFor(node.key);
  for (const row of waitingRows) {
    if (row.nodeKey) statsFor(row.nodeKey).waiting = Number(row.count);
  }
  for (const row of ledgerRows) {
    if (!row.nodeKey) continue;
    const s = statsFor(row.nodeKey);
    s.sent = Number(row.sent);
    s.delivered = Number(row.delivered);
    s.opened = Number(row.opened);
    s.clicked = Number(row.clicked);
    s.bounced = Number(row.bounced);
    s.complained = Number(row.complained);
    s.unsubscribed = Number(row.unsubscribed);
    s.failed = Number(row.failed);
    s.skipped = Number(row.skipped);
  }
  for (const row of skipRows) {
    if (!row.nodeKey) continue;
    statsFor(row.nodeKey).skippedByReason[row.reason ?? "unknown"] = Number(row.count);
  }

  return { counts: countsById.get(automation.id) ?? EMPTY_COUNTS(), nodes: [...byKey.values()] };
}

/* ───────────────────────────── enrollments ────────────────────────────── */

export const ENROLLMENT_PAGE_MAX = 200;

export async function listEnrollments(
  db: Db,
  accountId: string,
  id: string,
  opts: { status?: EnrollmentStatus | null; offset: number; limit: number },
): Promise<EnrollmentPage> {
  const automation = await findAutomationOr404(db, accountId, id);
  const limit = Math.min(Math.max(1, opts.limit), ENROLLMENT_PAGE_MAX);
  const offset = Math.max(0, opts.offset);
  const filters = [
    eq(automationEnrollments.automationId, automation.id),
    eq(automationEnrollments.accountId, accountId),
    ...(opts.status ? [eq(automationEnrollments.status, opts.status)] : []),
  ];

  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        enrollment: automationEnrollments,
        email: subscribers.email,
        versionNumber: automationVersions.version,
      })
      .from(automationEnrollments)
      .leftJoin(subscribers, eq(subscribers.id, automationEnrollments.subscriberId))
      .leftJoin(automationVersions, eq(automationVersions.id, automationEnrollments.automationVersionId))
      .where(and(...filters))
      .orderBy(desc(automationEnrollments.enteredAt), desc(automationEnrollments.id))
      .offset(offset)
      .limit(limit),
    db
      .select({ total: sql<number>`count(*)::int` })
      .from(automationEnrollments)
      .where(and(...filters)),
  ]);

  return {
    rows: rows.map(({ enrollment: e, email, versionNumber }): EnrollmentRow => ({
      id: e.id,
      subscriberId: e.subscriberId,
      email: email ?? "",
      status: e.status,
      versionNumber: versionNumber ?? 0,
      currentNodeKey: e.currentNodeKey,
      nextRunAt: e.nextRunAt,
      holdReason: e.holdReason,
      visitCount: e.visitCount,
      sendCount: e.sendCount,
      sandbox: e.sandbox,
      enteredAt: e.enteredAt,
      completedAt: e.completedAt,
      exitedAt: e.exitedAt,
      exitReason: e.exitReason,
      lastError: e.lastError,
    })),
    total: Number(total),
    offset,
    limit,
  };
}

// Enroll by address. The subscriber must already exist in the automation's
// audience; creating one is the caller's job (the v1 route does it when given
// attributes), because "enroll" must never quietly grow the list.
export async function enrollByEmail(
  db: Db,
  account: Account,
  automation: Automation,
  email: string,
  source: EnrollSource,
): Promise<EnrollResult> {
  const canonical = canonicalizeEmail(email);
  const subscriber = await db.query.subscribers.findFirst({
    where: and(
      eq(subscribers.accountId, account.id),
      eq(subscribers.audienceId, automation.audienceId),
      eq(subscribers.email, canonical),
    ),
  });
  if (!subscriber) return { outcome: "not_subscribed", enrollmentId: null };
  return enrollSubscriber(db, getQueue(), { automation, subscriberId: subscriber.id, source });
}

// The public enroll operation, shared by POST /v1/automations/{id}/enroll and
// the MCP tool. With `attributes` the contact is created (or its attributes
// merged) under the same rules as POST /v1/audiences/{id}/contacts, then
// enrolled with source "api". Throws ApiError, the v1 vocabulary.
export async function enrollContactByApi(
  db: Db,
  account: Account,
  automation: Automation,
  input: { email: string; attributes?: Record<string, string | null> },
): Promise<EnrollResult> {
  if (automation.status !== "active" || !automation.liveVersionId) {
    throw new ApiError(
      409,
      "invalid_request",
      `This automation is ${automation.status === "draft" ? "not published" : automation.status}. Publish and activate it in Day3 before enrolling anyone.`,
    );
  }
  const email = canonicalizeEmail(input.email);
  if (!isValidEmail(email)) {
    throw new ApiError(400, "invalid_email", "Invalid email address", { param: "email" });
  }
  if (input.attributes !== undefined) {
    const startedAt = nowIso();
    const { results } = await writeContacts(
      db,
      account,
      automation.audienceId,
      [{ email, attributes: input.attributes }],
      { upsert: true },
    );
    const result = results[0];
    if (result.status === "failed") {
      const status = result.code === "email_suppressed" ? 409 : 400;
      throw new ApiError(status, result.code, result.message, { param: "email" });
    }

    // writeContacts runs the audience-join hook, so on an `audience_join` flow a
    // contact that just became subscribed is already enrolled in THIS automation
    // by the time we get here. Enrolling again would be a second run under
    // re-entry `always`, and a misleading "already enrolled" under the other
    // modes for a person who did not exist a moment ago. Either way the caller
    // asked for one enrollment and the hook made it: hand that row back. Scoped
    // to rows created since this call began so an older run is never mistaken
    // for the hook's.
    const hooked = await db.query.automationEnrollments.findFirst({
      where: and(
        eq(automationEnrollments.automationId, automation.id),
        eq(automationEnrollments.accountId, account.id),
        eq(automationEnrollments.subscriberId, result.contact.id),
        gte(automationEnrollments.createdAt, startedAt),
      ),
      orderBy: desc(automationEnrollments.createdAt),
    });
    if (hooked) return { outcome: "enrolled", enrollmentId: hooked.id };
  }
  return enrollByEmail(db, account, automation, email, "api");
}

async function findEnrollment(
  db: Db,
  accountId: string,
  automationId: string,
  enrollmentId: string,
): Promise<AutomationEnrollment> {
  const enrollment = await db.query.automationEnrollments.findFirst({
    where: and(
      eq(automationEnrollments.id, enrollmentId),
      eq(automationEnrollments.automationId, automationId),
      eq(automationEnrollments.accountId, accountId),
    ),
  });
  if (!enrollment) throw new HttpError(404, "Enrollment not found");
  return enrollment;
}

// "Skip the wait": pull next_run_at to now and poke the engine. Only an active
// enrollment (running or sleeping) can be nudged; a sending one is owned by its
// batch and a finished one has nothing to run.
export async function runEnrollmentNow(
  db: Db,
  accountId: string,
  id: string,
  enrollmentId: string,
): Promise<void> {
  const automation = await findAutomationOr404(db, accountId, id);
  const enrollment = await findEnrollment(db, accountId, automation.id, enrollmentId);
  if (enrollment.status !== "active") {
    throw new HttpError(409, `An enrollment with status "${enrollment.status}" cannot be run.`);
  }
  const now = nowIso();
  const updated = await db
    .update(automationEnrollments)
    .set({ nextRunAt: now, updatedAt: now })
    .where(
      and(
        eq(automationEnrollments.id, enrollment.id),
        eq(automationEnrollments.accountId, accountId),
        eq(automationEnrollments.status, "active"),
      ),
    )
    .returning({ id: automationEnrollments.id });
  if (updated.length === 0) throw new HttpError(409, "The enrollment changed state; refresh and try again.");
  await getQueue().send({ type: "advance_automation_enrollment", enrollmentId: enrollment.id, accountId });
}

export async function exitEnrollment(
  db: Db,
  accountId: string,
  id: string,
  enrollmentId: string,
): Promise<void> {
  const automation = await findAutomationOr404(db, accountId, id);
  const enrollment = await findEnrollment(db, accountId, automation.id, enrollmentId);
  if (enrollment.status !== "active" && enrollment.status !== "sending") {
    throw new HttpError(409, `An enrollment with status "${enrollment.status}" has already finished.`);
  }
  const now = nowIso();
  await db
    .update(automationEnrollments)
    .set({ status: "exited", exitReason: "manual", exitedAt: now, updatedAt: now })
    .where(
      and(
        eq(automationEnrollments.id, enrollment.id),
        eq(automationEnrollments.accountId, accountId),
        inArray(automationEnrollments.status, ["active", "sending"]),
      ),
    );
}

/* ─────────────────────────────── test send ────────────────────────────── */

// "Send me this step": the draft version of one send node, rendered with the
// automation's From identity, theme and footer, through sendCampaignTest so the
// gates, sandbox metering and rendering are the campaign test's, not a copy.
// sendCampaignTest performs no write keyed on the campaign id (its only ledger
// touch is the account-level sandbox reservation), which is what makes handing
// it a campaign-shaped view of the node safe.
export async function sendAutomationNodeTest(
  db: Db,
  account: Account,
  automation: Automation,
  nodeKey: string,
  toEmails: string[],
): Promise<TestSendResult> {
  const draftVersionId = await ensureDraftVersionId(db, automation);
  const node = await db.query.automationNodes.findFirst({
    where: and(
      eq(automationNodes.automationVersionId, draftVersionId),
      eq(automationNodes.accountId, account.id),
      eq(automationNodes.key, nodeKey),
    ),
  });
  if (!node || node.kind !== "send") throw new HttpError(404, "Email step not found");
  const parsed = SendNodeConfigSchema.safeParse(parseConfig(node.configJson));
  if (!parsed.success) {
    throw new HttpError(400, "Add a subject and some content to this step before sending a test.");
  }
  const config = parsed.data;

  const campaignLike = {
    id: automation.id,
    accountId: account.id,
    audienceId: automation.audienceId,
    subject: config.subject,
    previewText: config.previewText,
    htmlBody: config.htmlBody,
    textBody: config.textBody,
    fromName: automation.fromName ?? "",
    fromEmail: automation.fromEmail ?? "",
    replyTo: automation.replyTo,
    sendingDomainId: automation.sendingDomainId ?? "",
    themeJson: automation.themeJson,
    footerText: automation.footerText,
  } satisfies Partial<Campaign>;

  return sendCampaignTest(db, account, campaignLike as Campaign, toEmails);
}

/* ─────────────────────────────── listing ──────────────────────────────── */

// The rows the public list endpoints return: the automation plus its live
// version number. Shared by GET /v1/automations and the MCP list tool. Archived
// automations are hidden unless asked for by status, matching the app's list.
export type AutomationApiRow = Automation & { liveVersion: number | null };

export async function listAutomationsForApi(
  db: Db,
  accountId: string,
  opts: { status?: string | null; limit: number; after?: PageCursor | null },
): Promise<AutomationApiRow[]> {
  const filters = [eq(automations.accountId, accountId)];
  if (opts.status) {
    // Validated here rather than per caller so the REST route and the MCP tool
    // answer a typo the same way (a 400, not a silently empty list).
    if (!(AUTOMATION_STATUSES as readonly string[]).includes(opts.status)) {
      throw new ApiError(400, "invalid_request", `Unknown status "${opts.status}"`, { param: "status" });
    }
    filters.push(eq(automations.status, opts.status as Automation["status"]));
  } else {
    filters.push(ne(automations.status, "archived"));
  }
  if (opts.after) filters.push(cursorCondition(automations.createdAt, automations.id, opts.after));
  return db
    .select({
      ...getTableColumns(automations),
      // Written literally: an interpolated column renders unqualified inside a
      // single-table select's subquery and would resolve against `v`.
      liveVersion: sql<number | null>`(
        SELECT v.version FROM automation_versions v WHERE v.id = automations.live_version_id
      )`.as("liveVersion"),
    })
    .from(automations)
    .where(and(...filters))
    .orderBy(desc(automations.createdAt), desc(automations.id))
    .limit(opts.limit);
}

export type { AutomationListRow };
