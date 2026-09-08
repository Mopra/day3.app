"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { CopyButton } from "@/components/copy-button";
import { Snippet } from "@/components/api-snippet";
import {
  BUILTIN_FIELD_OPTIONS,
  OP_LABELS,
} from "@/components/automation-canvas/segment-filter-builder";
import { useApi } from "@/lib/api";
import { apiBaseUrl } from "@/lib/api-docs";
import {
  MAX_CONDITIONS,
  NUMERIC_OPS,
  NUMERIC_VALUE_RE,
  SEGMENT_OPS,
  VALUELESS_OPS,
} from "@/lib/segment-filter-schema";
import { cn } from "@/lib/utils";
import type {
  AutomationDetail,
  AutomationReentryMode,
  AutomationSettingsInput,
  AutomationTriggerKind,
  SendWindow,
} from "@/lib/automation-types";
import type { Audience, AudienceField, SegmentFilter, Sender, SignupForm } from "@/lib/types";

// The settings that live on the automation row rather than on a version: who
// gets in, who gets thrown out, who it is from, and when it is allowed to send.
// Every field autosaves the way the composer does: quietly, a moment after the
// last keystroke, with a toast only when the save fails. Settings apply to the
// next send for everyone, including people already in progress, because the From
// identity, footer and window are read at send time (automation-types.ts).
//
// Prop-driven and chrome-free on purpose: the detail page decides where this sits
// (a side panel, a tab) and owns the header, the sandbox banner and the publish
// controls.

// How long a text field must sit unchanged before we save it. Selects and
// checkboxes save at once; there is nothing to wait for.
const TEXT_DEBOUNCE_MS = 700;

// The filter vocabulary comes from the database-free half of the segment model
// and the labels from the canvas's builder, so the entry/exit editors here and
// the branch editor on the canvas cannot disagree about what an op is called.
const OPS = SEGMENT_OPS.map((value) => ({ value, label: OP_LABELS[value] }));
const VALUELESS = new Set<string>(VALUELESS_OPS);
const NUMERIC = new Set<string>(NUMERIC_OPS);
const BUILTIN_FIELDS = BUILTIN_FIELD_OPTIONS;

type DraftCondition = { field: string; op: string; value: string };
type FilterDraft = { match: "all" | "any"; conditions: DraftCondition[] };

const NEW_CONDITION: DraftCondition = { field: "email", op: "contains", value: "" };
const EMPTY_FILTER: FilterDraft = { match: "all", conditions: [NEW_CONDITION] };

function toDraft(filter: SegmentFilter): FilterDraft {
  return {
    match: filter.match,
    conditions: filter.conditions.map((c) => ({ field: c.field, op: c.op, value: c.value ?? "" })),
  };
}

// A draft to the API shape, or null while it is incomplete (a blank value on an
// op that needs one, a non-number on a numeric op). Only complete filters save.
function fromDraft(draft: FilterDraft): SegmentFilter | null {
  const conditions = draft.conditions.map((c) => ({
    field: c.field,
    op: c.op as SegmentFilter["conditions"][number]["op"],
    value: VALUELESS.has(c.op) ? undefined : c.value.trim(),
  }));
  for (const c of conditions) {
    if (!VALUELESS.has(c.op) && !c.value) return null;
    if (NUMERIC.has(c.op) && !NUMERIC_VALUE_RE.test(c.value ?? "")) return null;
  }
  return { match: draft.match, conditions };
}

const REENTRY_OPTIONS: { value: AutomationReentryMode; title: string; hint: string }[] = [
  {
    value: "once",
    title: "Once",
    hint: "Each person goes through one time, ever. A re-import can't send the welcome twice.",
  },
  {
    value: "once_at_a_time",
    title: "Once at a time",
    hint: "They can go through again after finishing, but never twice at the same time.",
  },
  {
    value: "always",
    title: "Every time",
    hint: "Every trigger starts a fresh run, even mid-flight. For events that recur, like a trial ending.",
  },
];

// Monday first, the way a working week is written; the values stay 0 = Sunday to
// match SendWindow.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_WINDOW: SendWindow = { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };

// Sentinel for "no form narrowing" in the form select; an empty string is not a
// value Base UI's Select will hold.
const ANY_FORM = "__any__";

function senderVerified(s: Sender): boolean {
  return !!s.adminOverrideVerified || s.verificationStatus === "verified";
}

// The IANA zones the browser knows, with the automation's own zone guaranteed a
// place even when the browser's list disagrees (an older engine, a renamed zone).
function timezoneOptions(current: string): string[] {
  let zones: string[] = [];
  try {
    const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] };
    zones = intl.supportedValuesOf ? intl.supportedValuesOf("timeZone") : [];
  } catch {
    zones = [];
  }
  if (!zones.includes(current)) zones = [current, ...zones];
  if (!zones.includes("UTC")) zones = ["UTC", ...zones];
  return zones;
}

export function AutomationSettingsPanel({
  automation,
  audiences,
  senders,
  forms,
  onSaved,
}: {
  automation: AutomationDetail;
  audiences: Audience[];
  senders: Sender[];
  forms: SignupForm[];
  onSaved: (detail: AutomationDetail) => void;
}) {
  const api = useApi();
  const disabled = automation.status === "archived";

  /* ────────────────────────── autosave plumbing ────────────────────────── */

  // Edits accumulate here between keystrokes and go out as one PATCH. Held in
  // refs so a fast typist doesn't re-arm effects on every character.
  const pending = useRef<AutomationSettingsInput>({});
  const inflight = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onSavedRef = useRef(onSaved);
  onSavedRef.current = onSaved;
  const idRef = useRef(automation.id);
  idRef.current = automation.id;

  async function flush() {
    if (inflight.current) {
      // Let the current request land first; its response is the base the next
      // one should merge onto server-side.
      timer.current = setTimeout(() => void flush(), 150);
      return;
    }
    const body = pending.current;
    if (Object.keys(body).length === 0) return;
    pending.current = {};
    inflight.current = true;
    try {
      const detail = await api.patch<AutomationDetail>(`/api/automations/${idRef.current}`, body);
      onSavedRef.current(detail);
    } catch (err) {
      // The local value stays so nothing the user typed vanishes; the next edit
      // to that field retries. Not re-queued automatically: a rejected value
      // would otherwise toast on every later save of any other field.
      toast.error(err instanceof Error ? err.message : "Couldn't save the automation settings");
    } finally {
      inflight.current = false;
      if (Object.keys(pending.current).length > 0) void flush();
    }
  }

  function queueSave(patch: AutomationSettingsInput, delayMs = 0) {
    pending.current = { ...pending.current, ...patch };
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), delayMs);
  }

  // Leaving the page mid-debounce must not lose the last edit. Best-effort: the
  // response has nowhere to go, so it is fired and forgotten.
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
      const body = pending.current;
      pending.current = {};
      if (Object.keys(body).length > 0) {
        void api.patch(`/api/automations/${idRef.current}`, body).catch(() => {});
      }
    };
  }, [api]);

  /* ─────────────────────────── local field state ───────────────────────── */

  const [triggerKind, setTriggerKind] = useState<AutomationTriggerKind>(automation.triggerKind);
  const [triggerFormId, setTriggerFormId] = useState<string | null>(automation.triggerFormId);
  const [reentry, setReentry] = useState<AutomationReentryMode>(automation.reentry);
  const [senderId, setSenderId] = useState<string | null>(automation.senderId);
  const [replyTo, setReplyTo] = useState(automation.replyTo ?? "");
  const [footerText, setFooterText] = useState(automation.footerText ?? "");
  const [timezone, setTimezone] = useState(automation.timezone);
  const [sendWindow, setSendWindow] = useState<SendWindow | null>(automation.sendWindow);
  // Filters keep a draft shape (strings, possibly incomplete) because a half-typed
  // condition is a legitimate state to sit in; null means "no filter".
  const [entryDraft, setEntryDraft] = useState<FilterDraft | null>(
    automation.entryFilter ? toDraft(automation.entryFilter) : null,
  );
  const [exitDraft, setExitDraft] = useState<FilterDraft | null>(
    automation.exitFilter ? toDraft(automation.exitFilter) : null,
  );
  // What the server last told us each filter was. A fresh detail only overwrites
  // a filter draft when the server's value actually moved, so a save of some
  // other field can't wipe a condition the user is halfway through typing.
  const serverEntry = useRef(JSON.stringify(automation.entryFilter));
  const serverExit = useRef(JSON.stringify(automation.exitFilter));

  // Resync from the server when nothing of ours is still in flight or waiting.
  // While something is, the local state is newer than the prop and wins.
  useEffect(() => {
    const busy = inflight.current || Object.keys(pending.current).length > 0;
    if (!busy) {
      setTriggerKind(automation.triggerKind);
      setTriggerFormId(automation.triggerFormId);
      setReentry(automation.reentry);
      setSenderId(automation.senderId);
      setReplyTo(automation.replyTo ?? "");
      setFooterText(automation.footerText ?? "");
      setTimezone(automation.timezone);
      setSendWindow(automation.sendWindow);
    }
    const entryJson = JSON.stringify(automation.entryFilter);
    if (entryJson !== serverEntry.current) {
      serverEntry.current = entryJson;
      setEntryDraft(automation.entryFilter ? toDraft(automation.entryFilter) : null);
    }
    const exitJson = JSON.stringify(automation.exitFilter);
    if (exitJson !== serverExit.current) {
      serverExit.current = exitJson;
      setExitDraft(automation.exitFilter ? toDraft(automation.exitFilter) : null);
    }
  }, [automation]);

  /* ───────────────────────────── lookups ───────────────────────────────── */

  const audienceName =
    audiences.find((a) => a.id === automation.audienceId)?.name ?? automation.audienceName;
  const audienceForms = useMemo(
    () => forms.filter((f) => f.audienceId === automation.audienceId),
    [forms, automation.audienceId],
  );
  const selectedSender = senders.find((s) => s.id === senderId) ?? null;
  const senderItems = useMemo(
    () => Object.fromEntries(senders.map((s) => [s.id, `${s.fromName} <${s.fromEmail}>`])),
    [senders],
  );
  const zones = useMemo(() => timezoneOptions(timezone), [timezone]);

  // The custom-field registry for the condition builders. Read once, and only
  // once a filter is actually on; most automations never open one.
  const [fields, setFields] = useState<AudienceField[] | null>(null);
  const wantsFields = entryDraft !== null || exitDraft !== null;
  useEffect(() => {
    if (!wantsFields || fields !== null) return;
    let live = true;
    api
      .get<{ fields: AudienceField[] }>(`/api/audiences/${automation.audienceId}/fields`)
      .then((res) => live && setFields(res.fields))
      .catch(() => live && setFields([]));
    return () => {
      live = false;
    };
  }, [api, wantsFields, fields, automation.audienceId]);

  // The origin is only known in the browser; the placeholder keeps the snippet
  // readable during the server render.
  const [origin, setOrigin] = useState("https://day3.app");
  useEffect(() => setOrigin(window.location.origin), []);
  const enrollCurl =
    `curl -X POST ${apiBaseUrl(origin)}/automations/${automation.id}/enroll \\\n` +
    `  -H "Authorization: Bearer $DAY3_API_KEY" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"email":"jane@acme.com","attributes":{"plan":"pro"}}'`;

  /* ───────────────────────────── handlers ──────────────────────────────── */

  function changeTrigger(kind: AutomationTriggerKind) {
    setTriggerKind(kind);
    // A form narrowing only means something on the audience trigger.
    if (kind === "api" && triggerFormId) {
      setTriggerFormId(null);
      queueSave({ triggerKind: kind, triggerFormId: null });
    } else {
      queueSave({ triggerKind: kind });
    }
  }

  function changeFilter(which: "entry" | "exit", draft: FilterDraft | null) {
    (which === "entry" ? setEntryDraft : setExitDraft)(draft);
    const key = which === "entry" ? "entryFilter" : "exitFilter";
    if (draft === null) {
      queueSave({ [key]: null });
      return;
    }
    const filter = fromDraft(draft);
    // Incomplete drafts stay local; the hint under the editor says so.
    if (filter) queueSave({ [key]: filter }, TEXT_DEBOUNCE_MS);
  }

  function changeSender(s: Sender) {
    setSenderId(s.id);
    // The composer sets all four together; the send path reads whichever it
    // needs, so keep them in step rather than trusting one to imply the rest.
    queueSave({
      senderId: s.id,
      sendingDomainId: s.sendingDomainId,
      fromName: s.fromName,
      fromEmail: s.fromEmail,
    });
  }

  function changeWindow(next: SendWindow | null) {
    setSendWindow(next);
    if (next === null) {
      queueSave({ sendWindow: null });
      return;
    }
    // A window that ends before it starts, or has no days, can never open; hold
    // it locally until it makes sense rather than bouncing off the server.
    if (next.days.length === 0 || next.from >= next.to) return;
    queueSave({ sendWindow: next });
  }

  const windowInvalid =
    sendWindow !== null && (sendWindow.days.length === 0 || sendWindow.from >= sendWindow.to);

  /* ────────────────────────────── render ───────────────────────────────── */

  return (
    <fieldset disabled={disabled} className="min-w-0 divide-y divide-border">
      <Section
        title="Trigger"
        hint={`Audience: ${audienceName}. Set when the automation was created; for another audience, make another automation.`}
      >
        <div role="radiogroup" aria-label="Trigger" className="space-y-2">
          <ChoiceCard
            name="trigger"
            checked={triggerKind === "audience_join"}
            onSelect={() => changeTrigger("audience_join")}
            title={`When someone joins ${audienceName}`}
            hint="Anyone who becomes subscribed here: a signup form, an import, the API, or you adding them by hand."
          />
          <ChoiceCard
            name="trigger"
            checked={triggerKind === "api"}
            onSelect={() => changeTrigger("api")}
            title="When your app enrolls them"
            hint="Your backend fires it for its own moments: a trial started, a plan changed. Anyone it names must be in this audience, or is added to it."
          />
        </div>

        {triggerKind === "audience_join" ? (
          <Field label="Only signups from" htmlFor="triggerForm">
            <Select
              items={{
                [ANY_FORM]: "Any way they join",
                ...Object.fromEntries(audienceForms.map((f) => [f.id, f.name])),
              }}
              value={triggerFormId ?? ANY_FORM}
              onValueChange={(v) => {
                const next = v && v !== ANY_FORM ? (v as string) : null;
                setTriggerFormId(next);
                queueSave({ triggerFormId: next });
              }}
            >
              <SelectTrigger id="triggerForm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ANY_FORM}>Any way they join</SelectItem>
                {audienceForms.map((f) => (
                  <SelectItem key={f.id} value={f.id}>
                    {f.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Hint>
              {audienceForms.length === 0
                ? "You have no signup forms for this audience yet, so everyone who joins qualifies."
                : "Pick a form to greet only the people it brought in."}
            </Hint>
          </Field>
        ) : (
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <Label className="text-muted-foreground">From your backend</Label>
              <CopyButton value={enrollCurl} label="Copy" />
            </div>
            <Snippet code={enrollCurl} />
            <Hint>
              Needs an API key with the <code className="font-mono">automations:enroll</code> scope.{" "}
              <Link href="/api-keys" className="underline underline-offset-2 hover:text-foreground">
                Manage keys
              </Link>
              . Optional <code className="font-mono">attributes</code> are saved on the contact and
              usable as merge tags.
            </Hint>
          </div>
        )}
      </Section>

      <Section
        title="Entry condition"
        hint="Checked once, the moment they would enter. Someone who doesn't match is skipped, and stays out unless the trigger fires for them again."
      >
        <Toggle
          id="entryOn"
          checked={entryDraft !== null}
          onChange={(on) => changeFilter("entry", on ? EMPTY_FILTER : null)}
          label="Only enroll people who match a filter"
        />
        {entryDraft && (
          <FilterEditor
            idPrefix="entry"
            audienceId={automation.audienceId}
            draft={entryDraft}
            fields={fields}
            onChange={(d) => changeFilter("entry", d)}
            subject="qualify"
          />
        )}
      </Section>

      <Section
        title="Exit condition"
        hint="Stop the whole automation when they match. Checked before every step: whoever matches leaves wherever they are and gets nothing more from it. 'Plan is pro' in a trial series, for instance."
      >
        <Toggle
          id="exitOn"
          checked={exitDraft !== null}
          onChange={(on) => changeFilter("exit", on ? EMPTY_FILTER : null)}
          label="Remove people who match a filter"
        />
        {exitDraft && (
          <FilterEditor
            idPrefix="exit"
            audienceId={automation.audienceId}
            draft={exitDraft}
            fields={fields}
            onChange={(d) => changeFilter("exit", d)}
            subject="would leave"
          />
        )}
      </Section>

      <Section
        title="Re-entry"
        hint="What happens when the trigger fires for someone who has been through before."
      >
        <div role="radiogroup" aria-label="Re-entry" className="space-y-2">
          {REENTRY_OPTIONS.map((o) => (
            <ChoiceCard
              key={o.value}
              name="reentry"
              checked={reentry === o.value}
              onSelect={() => {
                setReentry(o.value);
                queueSave({ reentry: o.value });
              }}
              title={o.title}
              hint={o.hint}
            />
          ))}
        </div>
      </Section>

      <Section
        title="From"
        hint="Every email in this automation leaves from this identity. A change applies to the next send, for everyone, including people already in progress."
      >
        <Field label="Sender" htmlFor="automationSender">
          {senders.length > 0 ? (
            <Select
              items={senderItems}
              value={senderId ?? null}
              onValueChange={(v) => {
                const s = senders.find((x) => x.id === v);
                if (s) changeSender(s);
              }}
            >
              <SelectTrigger id="automationSender" aria-label="Sender" className="w-full">
                <SelectValue placeholder="Choose who this is from…" />
              </SelectTrigger>
              <SelectContent>
                {senders.map((s) => {
                  const verified = senderVerified(s);
                  return (
                    <SelectItem key={s.id} value={s.id} disabled={!verified}>
                      <span className="font-medium">{s.fromName}</span>{" "}
                      <span className="text-muted-foreground">&lt;{s.fromEmail}&gt;</span>
                      {!verified && (
                        <span className="ml-1 text-xs text-muted-foreground">
                          · domain needs setup
                        </span>
                      )}
                    </SelectItem>
                  );
                })}
              </SelectContent>
            </Select>
          ) : (
            <Hint>
              You have no senders yet.{" "}
              <Link
                href="/sending?tab=senders"
                className="underline underline-offset-2 hover:text-foreground"
              >
                Add a sender
              </Link>{" "}
              on a verified domain, then pick it here. Publishing needs one.
            </Hint>
          )}
        </Field>
        <Field label="Reply-to" htmlFor="automationReplyTo">
          <Input
            id="automationReplyTo"
            type="email"
            inputMode="email"
            autoComplete="off"
            placeholder={selectedSender?.replyTo || "Same as the From address"}
            value={replyTo}
            onChange={(e) => {
              setReplyTo(e.target.value);
              queueSave({ replyTo: e.target.value.trim() || null }, TEXT_DEBOUNCE_MS);
            }}
          />
          <Hint>Where replies land. Leave blank to use the sender&apos;s own reply-to.</Hint>
        </Field>
        <Field label="Footer text" htmlFor="automationFooter">
          <Textarea
            id="automationFooter"
            rows={2}
            placeholder="You're getting this because you signed up at acme.com."
            value={footerText}
            onChange={(e) => {
              setFooterText(e.target.value);
              queueSave({ footerText: e.target.value.trim() || null }, TEXT_DEBOUNCE_MS);
            }}
          />
          <Hint>
            Shown above your business address and the unsubscribe link in every email this
            automation sends. Blank uses the default wording.
          </Hint>
        </Field>
      </Section>

      <Section
        title="Timing"
        hint="Wait steps count in this timezone, and so does the send window."
      >
        <Field label="Timezone" htmlFor="automationTimezone">
          <Select
            items={zones.map((z) => ({ value: z, label: z.replace(/_/g, " ") }))}
            value={timezone}
            onValueChange={(v) => {
              if (!v) return;
              setTimezone(v as string);
              queueSave({ timezone: v as string });
            }}
          >
            <SelectTrigger id="automationTimezone" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {zones.map((z) => (
                <SelectItem key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Toggle
          id="windowOn"
          checked={sendWindow !== null}
          onChange={(on) => changeWindow(on ? DEFAULT_WINDOW : null)}
          label="Keep sends inside a window"
        />
        {sendWindow && (
          <div className="space-y-3 pl-6">
            <div role="group" aria-label="Days" className="flex flex-wrap gap-1.5">
              {DAY_ORDER.map((d) => {
                const on = sendWindow.days.includes(d);
                return (
                  <button
                    key={d}
                    type="button"
                    aria-pressed={on}
                    // The last remaining day can't be switched off: a window with
                    // no days would never open and every clamped wait would hang.
                    disabled={on && sendWindow.days.length === 1}
                    onClick={() =>
                      changeWindow({
                        ...sendWindow,
                        days: on
                          ? sendWindow.days.filter((x) => x !== d)
                          : [...sendWindow.days, d].sort((a, b) => a - b),
                      })
                    }
                    className={cn(
                      "h-8 min-w-11 rounded-md border px-2 text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed",
                      on
                        ? "border-foreground/60 bg-muted text-foreground"
                        : "border-border text-muted-foreground hover:text-foreground",
                    )}
                  >
                    {DAY_LABELS[d]}
                  </button>
                );
              })}
            </div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Label htmlFor="windowFrom" className="w-10 text-muted-foreground">
                From
              </Label>
              <Input
                id="windowFrom"
                type="time"
                step={900}
                className="w-32"
                value={sendWindow.from}
                onChange={(e) => e.target.value && changeWindow({ ...sendWindow, from: e.target.value })}
              />
              <Label htmlFor="windowTo" className="w-10 text-muted-foreground sm:ml-2">
                to
              </Label>
              <Input
                id="windowTo"
                type="time"
                step={900}
                className="w-32"
                value={sendWindow.to}
                onChange={(e) => e.target.value && changeWindow({ ...sendWindow, to: e.target.value })}
              />
            </div>
            {windowInvalid ? (
              <Hint tone="warn">The window ends before it starts, so it isn&apos;t saved yet.</Hint>
            ) : (
              <Hint>
                Only wait steps that opt in are held for the window: a wait with &quot;hold for
                the send window&quot; on lands on the next open hour, and the email after it goes
                out then. Everything else runs the moment it&apos;s due.
              </Hint>
            )}
          </div>
        )}
      </Section>
    </fieldset>
  );
}

/* ─────────────────────────── building blocks ─────────────────────────── */

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="space-y-3 py-5 first:pt-0 last:pb-0">
      <div className="space-y-1">
        <h3 className="text-sm font-medium">{title}</h3>
        {hint && <p className="text-sm leading-relaxed text-muted-foreground">{hint}</p>}
      </div>
      {children}
    </section>
  );
}

function Field({ label, htmlFor, children }: { label: string; htmlFor?: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
    </div>
  );
}

function Hint({ children, tone }: { children: ReactNode; tone?: "warn" }) {
  return (
    <p
      className={cn(
        "text-xs leading-relaxed",
        tone === "warn" ? "text-destructive" : "text-muted-foreground",
      )}
    >
      {children}
    </p>
  );
}

// A native checkbox in the app's usual clothes (see the forms dialog). The label
// carries the whole row so the hit area is the text, not a 16px square.
function Toggle({
  id,
  checked,
  onChange,
  label,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <label htmlFor={id} className="flex cursor-pointer items-center gap-2.5 text-sm">
      <input
        id={id}
        type="checkbox"
        className="size-4 accent-primary"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="font-medium">{label}</span>
    </label>
  );
}

// One option of a radio set, laid out as a card so the explanation sits under
// its title instead of trailing off the end of a line. The native input does the
// keyboard work; the border only says which one is chosen.
function ChoiceCard({
  name,
  checked,
  onSelect,
  title,
  hint,
}: {
  name: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  hint: string;
}) {
  return (
    <label
      className={cn(
        "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm transition-colors",
        checked ? "border-foreground/60 bg-muted/50" : "border-border hover:bg-muted/30",
      )}
    >
      <input
        type="radio"
        name={name}
        className="mt-0.5 size-4 shrink-0 accent-primary"
        checked={checked}
        onChange={onSelect}
      />
      <span className="min-w-0">
        <span className="block font-medium leading-snug">{title}</span>
        <span className="block text-xs leading-relaxed text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

// The Segments tab's condition builder, over the same model, with the same live
// "N match right now" count (design doc §8). Kept inline here because the tab's
// editor is not yet a shared component; when it becomes one, both should use it.
function FilterEditor({
  idPrefix,
  audienceId,
  draft,
  fields,
  onChange,
  subject,
}: {
  idPrefix: string;
  audienceId: string;
  draft: FilterDraft;
  fields: AudienceField[] | null;
  onChange: (draft: FilterDraft) => void;
  // Verb for the count line: "412 people qualify" vs "12 people would leave".
  subject: string;
}) {
  const api = useApi();
  const fieldOptions = useMemo(
    () => [...BUILTIN_FIELDS, ...(fields ?? []).map((f) => ({ key: f.key, label: f.label }))],
    [fields],
  );
  const filter = useMemo(() => fromDraft(draft), [draft]);
  const filterJson = JSON.stringify(filter);

  const [preview, setPreview] = useState<number | null>(null);
  useEffect(() => {
    if (!filter) {
      setPreview(null);
      return;
    }
    let live = true;
    const t = setTimeout(() => {
      api
        .post<{ count: number }>(`/api/audiences/${audienceId}/segments/preview`, { filter })
        .then((res) => live && setPreview(res.count))
        .catch(() => live && setPreview(null));
    }, 350);
    return () => {
      live = false;
      clearTimeout(t);
    };
    // Keyed on the serialized filter so retyping the same value doesn't refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterJson, audienceId]);

  function setCondition(i: number, patch: Partial<DraftCondition>) {
    onChange({
      ...draft,
      conditions: draft.conditions.map((c, j) => (j === i ? { ...c, ...patch } : c)),
    });
  }

  return (
    <div className="space-y-2 pl-6">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span>People matching</span>
        <Select
          items={{ all: "all", any: "any" }}
          value={draft.match}
          onValueChange={(v) => onChange({ ...draft, match: (v as "all" | "any") ?? "all" })}
        >
          <SelectTrigger aria-label="Match" size="sm" className="w-20">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">all</SelectItem>
            <SelectItem value="any">any</SelectItem>
          </SelectContent>
        </Select>
        <span>of these:</span>
      </div>

      <div className="space-y-2">
        {draft.conditions.map((c, i) => (
          <div key={i} className="flex flex-wrap items-center gap-2">
            <Select
              items={Object.fromEntries(fieldOptions.map((f) => [f.key, f.label]))}
              value={c.field}
              onValueChange={(v) => v && setCondition(i, { field: v as string })}
            >
              <SelectTrigger
                aria-label="Field"
                className="flex-1 basis-32 sm:w-36 sm:flex-none sm:shrink-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {fieldOptions.map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select
              items={Object.fromEntries(OPS.map((o) => [o.value, o.label]))}
              value={c.op}
              onValueChange={(v) => v && setCondition(i, { op: v as string })}
            >
              <SelectTrigger
                aria-label="Operator"
                className="flex-1 basis-32 sm:w-40 sm:flex-none sm:shrink-0"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {OPS.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {!VALUELESS.has(c.op) && (
              <Input
                aria-label="Value"
                id={`${idPrefix}-value-${i}`}
                className="flex-1 basis-40"
                placeholder={NUMERIC.has(c.op) ? "e.g. 10" : "value"}
                inputMode={NUMERIC.has(c.op) ? "decimal" : undefined}
                value={c.value}
                onChange={(e) => setCondition(i, { value: e.target.value })}
              />
            )}
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="shrink-0 text-muted-foreground hover:text-destructive"
              onClick={() =>
                onChange({ ...draft, conditions: draft.conditions.filter((_, j) => j !== i) })
              }
              disabled={draft.conditions.length === 1}
              aria-label="Remove condition"
            >
              <Trash2 className="size-4" />
            </Button>
          </div>
        ))}
      </div>

      {draft.conditions.length < MAX_CONDITIONS && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => onChange({ ...draft, conditions: [...draft.conditions, NEW_CONDITION] })}
        >
          <Plus className="size-3.5" /> Add condition
        </Button>
      )}

      <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
        {filter === null
          ? "Fill in every condition to save the filter and see how many people match."
          : preview === null
            ? "Counting…"
            : `${preview.toLocaleString()} ${preview === 1 ? "person" : "people"} ${subject} right now.`}
      </p>
    </div>
  );
}
