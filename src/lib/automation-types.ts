// The automation feature's shared wire types: what the session API routes under
// /api/automations return, what the client views consume, and what the v1 API
// serializes. Database-free (like lib/types.ts) so it can be imported from
// client components, route handlers, services and tests alike.
//
// This file is the contract several parallel workstreams code against. Change
// a shape here and every consumer must move with it.
import type { GraphValidation, NodePort, AutomationNodeKind } from "./automation-graph";
import type { SegmentFilter } from "./segment-filter-schema";
import type { CampaignTheme } from "./theme";

export type AutomationStatus = "draft" | "active" | "paused" | "archived";

// Phase 1 triggers. `segment_join` / `topic_join` exist in the schema enum but
// are not offered by the UI or accepted by the API until the write-hook
// evaluator lands (docs/automations-design.md §6.2).
export type AutomationTriggerKind = "audience_join" | "api";
export type AutomationReentryMode = "once" | "once_at_a_time" | "always";

export type EnrollmentStatus = "active" | "sending" | "completed" | "exited" | "failed";

// Working-hours clamp for wait nodes that opt in. `days` are 0 (Sunday) to 6,
// `from`/`to` are "HH:MM" 24h in the automation's timezone.
export type SendWindow = { days: number[]; from: string; to: string };

export type EnrollmentCounts = {
  active: number;
  sending: number;
  completed: number;
  exited: number;
  failed: number;
  total: number;
};

// One row of GET /api/automations (and the list the server page passes to the
// view). `liveVersion` is null until the first publish.
export type AutomationListRow = {
  id: string;
  name: string;
  status: AutomationStatus;
  triggerKind: AutomationTriggerKind;
  audienceId: string;
  audienceName: string;
  liveVersion: number | null;
  sandbox: boolean;
  counts: EnrollmentCounts;
  createdAt: string;
  updatedAt: string;
};

// A node as the canvas sees it: the stable key, its kind and config, the label,
// canvas coordinates, and (on published versions) the risk verdict recorded at
// publish. `config` is `unknown` because a draft node may be half-edited; the
// per-kind Zod schemas in lib/automation-graph.ts are the authority.
export type GraphPayloadNode = {
  key: string;
  kind: AutomationNodeKind;
  config: unknown;
  label: string | null;
  x: number;
  y: number;
  risk: { level: string; summary: string | null; guidance: string[] | null } | null;
};

export type GraphPayloadEdge = { fromKey: string; port: NodePort; toKey: string };

export type GraphPayload = { nodes: GraphPayloadNode[]; edges: GraphPayloadEdge[] };

// Body of PUT /api/automations/{id}/draft. Replaces the draft graph wholesale;
// node keys are preserved (the client mints new keys with `nd_` + random
// lowercase alphanumerics, max 40 chars, see NODE_KEY_RE in automation-graph.ts).
export type DraftGraphInput = {
  nodes: { key: string; kind: AutomationNodeKind; config: unknown; label?: string | null; x: number; y: number }[];
  edges: GraphPayloadEdge[];
};

export type AutomationVersionSummary = {
  id: string;
  version: number;
  publishedAt: string | null;
};

// GET /api/automations/{id}. `draft` is always present (a draft version is
// created with the automation); `live` is null until the first publish.
// `draftDirty` is true when the draft graph differs from the live graph, which
// is what the "Publish changes" button keys off.
export type AutomationDetail = {
  id: string;
  name: string;
  status: AutomationStatus;
  audienceId: string;
  audienceName: string;
  triggerKind: AutomationTriggerKind;
  triggerFormId: string | null;
  entryFilter: SegmentFilter | null;
  exitFilter: SegmentFilter | null;
  reentry: AutomationReentryMode;
  senderId: string | null;
  sendingDomainId: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  theme: CampaignTheme | null;
  footerText: string | null;
  topicId: string | null;
  sendWindow: SendWindow | null;
  timezone: string;
  sandbox: boolean;
  liveVersion: AutomationVersionSummary | null;
  draftVersionId: string;
  draft: GraphPayload;
  live: GraphPayload | null;
  draftDirty: boolean;
  // Validation of the current draft, recomputed on every read and every draft save.
  validation: GraphValidation;
  counts: EnrollmentCounts;
  createdAt: string;
  updatedAt: string;
};

// Body of PATCH /api/automations/{id}. Every field optional; omitted fields are
// left alone, explicit null clears a nullable field. Settings edits apply to the
// automation row (not a version), so they take effect for in-flight enrollments
// too: the From identity, theme and footer are read at send time.
export type AutomationSettingsInput = Partial<{
  name: string;
  triggerKind: AutomationTriggerKind;
  triggerFormId: string | null;
  entryFilter: SegmentFilter | null;
  exitFilter: SegmentFilter | null;
  reentry: AutomationReentryMode;
  senderId: string | null;
  sendingDomainId: string | null;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  theme: CampaignTheme | null;
  footerText: string | null;
  topicId: string | null;
  sendWindow: SendWindow | null;
  timezone: string;
}>;

// Body of POST /api/automations. `templateKey` seeds the draft graph from
// lib/automation-templates.ts; omitted means a blank canvas with just a trigger.
export type CreateAutomationInput = {
  name: string;
  audienceId: string;
  templateKey?: string | null;
};

// Publish failures come back as HTTP 422 with this body so the canvas can
// highlight the offending nodes. A successful publish returns AutomationDetail.
export type PublishFailure = { error: string; validation: GraphValidation };

// Per-node live state for the canvas badges and the stats table.
// `waiting` = enrollments sitting on the node right now (status active/sending).
// The send counters come off the shared send ledger (campaign_recipients rows
// with automation_node_key = key); `skipped` is broken out by reason because
// "why didn't this send?" is the number-one support question.
export type NodeStats = {
  nodeKey: string;
  waiting: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  failed: number;
  skipped: number;
  skippedByReason: Record<string, number>;
};

// GET /api/automations/{id}/stats
export type AutomationStats = { counts: EnrollmentCounts; nodes: NodeStats[] };

// One row of GET /api/automations/{id}/enrollments (paginated, newest first).
export type EnrollmentRow = {
  id: string;
  subscriberId: string;
  email: string;
  status: EnrollmentStatus;
  versionNumber: number;
  currentNodeKey: string | null;
  nextRunAt: string | null;
  holdReason: string | null;
  visitCount: number;
  sendCount: number;
  sandbox: boolean;
  enteredAt: string;
  completedAt: string | null;
  exitedAt: string | null;
  exitReason: string | null;
  lastError: string | null;
};

export type EnrollmentPage = { rows: EnrollmentRow[]; total: number; offset: number; limit: number };

// Why an enrollment attempt did or did not create a row. Every trigger path and
// the manual/API enroll endpoints return one of these; only `enrolled` made a row.
export type EnrollOutcome =
  | "enrolled"
  | "already_enrolled"
  | "automation_not_active"
  | "not_subscribed"
  | "suppressed"
  | "entry_filter_no_match"
  | "sandbox_not_member"
  | "wrong_audience";

export type EnrollResult = { outcome: EnrollOutcome; enrollmentId: string | null };

// Template catalogue entry, for the "new automation" picker.
export type AutomationTemplateSummary = {
  key: string;
  name: string;
  description: string;
  nodeCount: number;
};
