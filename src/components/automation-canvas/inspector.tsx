"use client";

import { useEffect, useState } from "react";
import { useUser } from "@clerk/nextjs";
import { toast } from "sonner";
import { AlertTriangle, Pencil, Send, Settings2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi } from "@/lib/api";
import {
  BranchNodeConfigSchema,
  SendNodeConfigSchema,
  WAIT_UNITS,
  WaitNodeConfigSchema,
  nodeTitle,
  type BranchCondition,
  type EngagementEvent,
  type GraphIssue,
  type WaitUnit,
} from "@/lib/automation-graph";
import type { AutomationDetail, GraphPayloadNode } from "@/lib/automation-types";
import type { SegmentFilter } from "@/lib/types";
import type { TestSendResult } from "@/services/campaign-send";
import { cn } from "@/lib/utils";
import { ENGAGEMENT_EVENTS, ENGAGEMENT_LABELS, KIND_META } from "./node-kinds";
import { SegmentFilterBuilder } from "./segment-filter-builder";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type NodePatch = { label?: string | null; config?: unknown };

// The right-hand panel for the selected node: its name, the issues the
// validator has with it, and a form for whatever its kind configures. A panel
// rather than a modal so the canvas stays in view while you edit.
export function NodeInspector({
  node,
  nodes,
  detail,
  issues,
  readOnly,
  onChange,
  onDelete,
  onEditEmail,
  onOpenSettings,
  onClose,
}: {
  node: GraphPayloadNode;
  nodes: GraphPayloadNode[];
  detail: AutomationDetail;
  issues: { errors: GraphIssue[]; warnings: GraphIssue[] };
  readOnly: boolean;
  onChange: (patch: NodePatch) => void;
  onDelete: () => void;
  onEditEmail: () => void;
  onOpenSettings: () => void;
  onClose: () => void;
}) {
  const meta = KIND_META[node.kind];
  const Icon = meta.icon;

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <span
          className={cn(
            "flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted",
            meta.tone,
          )}
        >
          <Icon className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
            {meta.label}
          </div>
          <div className="truncate text-sm font-medium leading-5">{nodeTitle(node)}</div>
        </div>
        <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
          <X />
        </Button>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-4 py-4">
        {(issues.errors.length > 0 || issues.warnings.length > 0) && (
          <ul className="space-y-1.5 text-xs">
            {issues.errors.map((i, idx) => (
              <li key={`e${idx}`} className="flex items-start gap-1.5 text-destructive">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span>{i.message}</span>
              </li>
            ))}
            {issues.warnings.map((i, idx) => (
              <li key={`w${idx}`} className="flex items-start gap-1.5 text-muted-foreground">
                <AlertTriangle className="mt-0.5 size-3 shrink-0" />
                <span>{i.message}</span>
              </li>
            ))}
          </ul>
        )}

        {node.kind !== "trigger" && (
          <div className="space-y-1.5">
            <Label htmlFor="nodeLabel">Name</Label>
            <Input
              id="nodeLabel"
              value={node.label ?? ""}
              placeholder={nodeTitle({ ...node, label: null })}
              disabled={readOnly}
              onChange={(e) => onChange({ label: e.target.value || null })}
            />
            <p className="text-xs text-muted-foreground">
              Shown on the canvas and in reports. Contacts never see it.
            </p>
          </div>
        )}

        {node.kind === "send" && (
          <SendForm
            node={node}
            detail={detail}
            readOnly={readOnly}
            onChange={onChange}
            onEditEmail={onEditEmail}
          />
        )}
        {node.kind === "wait" && (
          <WaitForm
            node={node}
            hasSendWindow={!!detail.sendWindow}
            readOnly={readOnly}
            onChange={onChange}
            onOpenSettings={onOpenSettings}
          />
        )}
        {node.kind === "branch" && (
          <BranchForm
            node={node}
            nodes={nodes}
            audienceId={detail.audienceId}
            readOnly={readOnly}
            onChange={onChange}
          />
        )}
        {node.kind === "trigger" && (
          <TriggerSummary detail={detail} onOpenSettings={onOpenSettings} />
        )}
        {node.kind === "end" && (
          <p className="text-sm text-muted-foreground">
            Anyone who reaches this step leaves the automation. A step with nothing after it
            ends the flow too; this one just says so on the canvas.
          </p>
        )}
      </div>

      {node.kind !== "trigger" && !readOnly && (
        <div className="border-t border-border px-4 py-3">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-destructive"
            onClick={onDelete}
          >
            <Trash2 />
            Remove step
          </Button>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────── send ────────────────────────────── */

function SendForm({
  node,
  detail,
  readOnly,
  onChange,
  onEditEmail,
}: {
  node: GraphPayloadNode;
  detail: AutomationDetail;
  readOnly: boolean;
  onChange: (patch: NodePatch) => void;
  onEditEmail: () => void;
}) {
  const api = useApi();
  const { user } = useUser();
  const parsed = SendNodeConfigSchema.safeParse(node.config ?? {});
  const config = parsed.success ? parsed.data : null;
  const subject = config?.subject.trim() ?? "";
  const hasContent = !!subject && !!config?.htmlBody.trim();

  // "Send me a test": one address, prefilled with the user's own. The endpoint
  // renders this node with the automation's From, theme and footer and runs the
  // same gates as a campaign test, so what lands is what a contact would get.
  const [to, setTo] = useState("");
  const [sending, setSending] = useState(false);
  useEffect(() => {
    setTo((cur) => cur || user?.primaryEmailAddress?.emailAddress || "");
  }, [user]);

  async function sendTest() {
    const email = to.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || sending) return;
    setSending(true);
    try {
      const res = await api.post<TestSendResult>(
        `/api/automations/${detail.id}/nodes/${node.key}/test-email`,
        { to: [email] },
      );
      if (res.sent.length > 0) toast.success(`Test sent to ${res.sent[0]}`);
      for (const f of res.failed) toast.error(`Couldn't send to ${f.email}: ${f.error}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't send test");
    } finally {
      setSending(false);
    }
  }

  // The verdict recorded for this node at the last publish, when it was not clean.
  const liveRisk = detail.live?.nodes.find((n) => n.key === node.key)?.risk ?? null;

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <p className="text-sm font-medium">Subject</p>
        <p className={cn("text-sm", !subject && "text-muted-foreground")}>
          {subject || "No subject yet"}
        </p>
        {config?.previewText?.trim() && (
          <p className="text-xs text-muted-foreground">{config.previewText}</p>
        )}
        <Button size="sm" onClick={onEditEmail}>
          <Pencil />
          {hasContent ? "Edit email" : "Write the email"}
        </Button>
      </div>

      <div className="space-y-2">
        <Label htmlFor="testTo">Send me a test</Label>
        <div className="flex items-center gap-2">
          <Input
            id="testTo"
            type="email"
            value={to}
            placeholder="name@example.com"
            onChange={(e) => setTo(e.target.value)}
            disabled={sending}
          />
          <Button
            variant="outline"
            size="sm"
            className="h-10 shrink-0 md:h-8"
            disabled={sending || !hasContent || !EMAIL_RE.test(to.trim().toLowerCase())}
            onClick={sendTest}
          >
            {sending ? <OrbitLoader size={14} /> : <Send />}
            Send
          </Button>
        </div>
        {!hasContent && (
          <p className="text-xs text-muted-foreground">Write the email first.</p>
        )}
      </div>

      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={config?.allowResend ?? false}
          disabled={readOnly || !config}
          onChange={(e) => config && onChange({ config: { ...config, allowResend: e.target.checked } })}
        />
        <span>
          <span className="block font-medium">Allow re-sending on loops</span>
          <span className="block text-xs text-muted-foreground">
            Off, this email goes to a contact at most once, even if the flow loops back to it.
            Turn it on only for a genuine recurring nudge: an accidental loop would otherwise
            mail people the same thing again.
          </span>
        </span>
      </label>

      {liveRisk && liveRisk.level !== "low" && (
        <div className="space-y-1 rounded-lg border border-border bg-muted/40 p-3 text-xs">
          <p className="font-medium">Safety review at last publish: {liveRisk.level}</p>
          {liveRisk.summary && <p className="text-muted-foreground">{liveRisk.summary}</p>}
          {liveRisk.guidance && liveRisk.guidance.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-muted-foreground">
              {liveRisk.guidance.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────── wait ────────────────────────────── */

const UNIT_LABELS: Record<WaitUnit, string> = {
  minutes: "minutes",
  hours: "hours",
  days: "days",
};

function WaitForm({
  node,
  hasSendWindow,
  readOnly,
  onChange,
  onOpenSettings,
}: {
  node: GraphPayloadNode;
  hasSendWindow: boolean;
  readOnly: boolean;
  onChange: (patch: NodePatch) => void;
  onOpenSettings: () => void;
}) {
  // Read leniently so a half-typed value (an empty number field) still renders
  // the form instead of falling back to defaults under the user's cursor.
  const raw = (node.config ?? {}) as Partial<{ value: unknown; unit: unknown; clampToSendWindow: unknown }>;
  const parsed = WaitNodeConfigSchema.safeParse(raw);
  const value = typeof raw.value === "number" ? raw.value : parsed.success ? parsed.data.value : 1;
  const unit: WaitUnit = WAIT_UNITS.includes(raw.unit as WaitUnit) ? (raw.unit as WaitUnit) : "days";
  const clamp = raw.clampToSendWindow === true;
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);

  function commit(patch: Partial<{ value: number; unit: WaitUnit; clampToSendWindow: boolean }>) {
    onChange({ config: { value, unit, clampToSendWindow: clamp, ...patch } });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-1.5">
        <Label htmlFor="waitValue">Wait for</Label>
        <div className="flex items-center gap-2">
          <Input
            id="waitValue"
            type="number"
            min={1}
            inputMode="numeric"
            className="w-24"
            value={text}
            disabled={readOnly}
            onChange={(e) => {
              setText(e.target.value);
              const n = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n >= 1) commit({ value: n });
            }}
            // A value the schema would reject ("", "0") never reaches the node;
            // on blur the field snaps back to what the node actually holds so
            // the canvas and the form agree.
            onBlur={() => setText(String(value))}
          />
          <Select
            items={UNIT_LABELS}
            value={unit}
            disabled={readOnly}
            onValueChange={(v) => v && commit({ unit: v as WaitUnit })}
          >
            <SelectTrigger aria-label="Unit" className="flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {WAIT_UNITS.map((u) => (
                <SelectItem key={u} value={u}>
                  {UNIT_LABELS[u]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <p className="text-xs text-muted-foreground">Up to 365 days.</p>
      </div>

      <label className="flex cursor-pointer items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-0.5 size-4 accent-primary"
          checked={clamp}
          disabled={readOnly}
          onChange={(e) => commit({ clampToSendWindow: e.target.checked })}
        />
        <span>
          <span className="block font-medium">Only continue during the send window</span>
          <span className="block text-xs text-muted-foreground">
            If the wait ends outside the window, the next step runs when the window opens.
            {!hasSendWindow && (
              <>
                {" "}
                No send window is set yet.{" "}
                <button
                  type="button"
                  onClick={onOpenSettings}
                  className="underline underline-offset-2 hover:text-foreground"
                >
                  Set one in Settings
                </button>
                .
              </>
            )}
          </span>
        </span>
      </label>
    </div>
  );
}

/* ───────────────────────────── branch ───────────────────────────── */

const DEFAULT_FILTER: SegmentFilter = {
  match: "all",
  conditions: [{ field: "email", op: "is_set" }],
};

function BranchForm({
  node,
  nodes,
  audienceId,
  readOnly,
  onChange,
}: {
  node: GraphPayloadNode;
  nodes: GraphPayloadNode[];
  audienceId: string;
  readOnly: boolean;
  onChange: (patch: NodePatch) => void;
}) {
  const api = useApi();
  // The raw condition, not the parsed one: a filter mid-edit (blank value) fails
  // the schema but must still round-trip through the builder.
  const raw = (node.config as { condition?: Partial<BranchCondition> } | null)?.condition;
  const kind: BranchCondition["kind"] = raw?.kind === "engagement" ? "engagement" : "filter";
  const parsed = BranchNodeConfigSchema.safeParse(node.config ?? {});
  const filter: SegmentFilter =
    kind === "filter" && raw && "filter" in raw && raw.filter && Array.isArray(raw.filter.conditions)
      ? (raw.filter as SegmentFilter)
      : DEFAULT_FILTER;
  const engagement =
    parsed.success && parsed.data.condition.kind === "engagement"
      ? parsed.data.condition
      : { kind: "engagement" as const, event: "opened" as EngagementEvent, nodeKey: null };

  const [fields, setFields] = useState<{ key: string; label: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<{ fields: { key: string; label: string }[] }>(`/api/audiences/${audienceId}/fields`)
      .then((res) => live && setFields(res.fields.map((f) => ({ key: f.key, label: f.label }))))
      .catch(() => live && setFields([]));
    return () => {
      live = false;
    };
  }, [api, audienceId]);

  const sendNodes = nodes.filter((n) => n.kind === "send" && n.key !== node.key);
  const emailItems: Record<string, string> = { any: "Any email in this automation" };
  for (const n of sendNodes) emailItems[n.key] = nodeTitle(n);
  if (engagement.nodeKey && !emailItems[engagement.nodeKey]) {
    emailItems[engagement.nodeKey] = "An email that was removed";
  }

  function setCondition(condition: BranchCondition | { kind: "filter"; filter: SegmentFilter }) {
    onChange({ config: { condition } });
  }

  return (
    <div className="space-y-4">
      <Tabs
        value={kind}
        onValueChange={(v) => {
          if (readOnly) return;
          if (v === "engagement") setCondition(engagement);
          else setCondition({ kind: "filter", filter });
        }}
      >
        <TabsList className="w-full">
          <TabsTrigger value="filter">Contact filter</TabsTrigger>
          <TabsTrigger value="engagement">Engagement</TabsTrigger>
        </TabsList>
      </Tabs>

      {kind === "filter" ? (
        <SegmentFilterBuilder
          value={filter}
          fields={fields}
          disabled={readOnly}
          onChange={(next) => setCondition({ kind: "filter", filter: next })}
        />
      ) : (
        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label htmlFor="branchEvent">The contact</Label>
            <Select
              items={ENGAGEMENT_LABELS}
              value={engagement.event}
              disabled={readOnly}
              onValueChange={(v) =>
                v && setCondition({ ...engagement, event: v as EngagementEvent })
              }
            >
              <SelectTrigger id="branchEvent" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ENGAGEMENT_EVENTS.map((e) => (
                  <SelectItem key={e} value={e}>
                    {ENGAGEMENT_LABELS[e]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="branchEmail">Which email</Label>
            <Select
              items={emailItems}
              value={engagement.nodeKey ?? "any"}
              disabled={readOnly}
              onValueChange={(v) =>
                setCondition({ ...engagement, nodeKey: !v || v === "any" ? null : (v as string) })
              }
            >
              <SelectTrigger id="branchEmail" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {Object.entries(emailItems).map(([value, label]) => (
                  <SelectItem key={value} value={value}>
                    {label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {sendNodes.length === 0 && (
              <p className="text-xs text-muted-foreground">
                Add an email step before this one to ask about a specific email.
              </p>
            )}
          </div>
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Contacts who match continue on <span className="font-medium">yes</span>, everyone else
        on <span className="font-medium">no</span>.
      </p>
    </div>
  );
}

/* ───────────────────────────── trigger ──────────────────────────── */

const REENTRY_COPY = {
  once: "Each contact can go through once.",
  once_at_a_time: "A contact can go through again once they have finished.",
  always: "A contact can enter again at any time.",
} as const;

function TriggerSummary({
  detail,
  onOpenSettings,
}: {
  detail: AutomationDetail;
  onOpenSettings: () => void;
}) {
  const how =
    detail.triggerKind === "api"
      ? "When your app enrolls a contact through the API."
      : detail.triggerFormId
        ? `When someone joins ${detail.audienceName} through a specific form.`
        : `When someone joins ${detail.audienceName}.`;
  return (
    <div className="space-y-3 text-sm">
      <p>{how}</p>
      {detail.entryFilter && (
        <p className="text-muted-foreground">Only contacts who match the entry filter enter.</p>
      )}
      {detail.exitFilter && (
        <p className="text-muted-foreground">
          Contacts who match the exit condition leave before their next step.
        </p>
      )}
      <p className="text-muted-foreground">{REENTRY_COPY[detail.reentry]}</p>
      <Button variant="outline" size="sm" onClick={onOpenSettings}>
        <Settings2 />
        Change in Settings
      </Button>
    </div>
  );
}
