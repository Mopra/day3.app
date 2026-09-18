"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { CopyButton } from "@/components/copy-button";
import { Snippet } from "@/components/api-snippet";
import {
  ANY_FORM,
  ChoiceCard,
  Field,
  Hint,
  REENTRY_OPTIONS,
  Section,
  TEXT_DEBOUNCE_MS,
  Toggle,
  completeFilter,
  matchCountLine,
  useAudienceFields,
  useAutomationSettingsSave,
  useFilterMatchCount,
  type SettingsSaveStatus,
} from "@/components/automation-settings-shared";
import { apiBaseUrl } from "@/lib/api-docs";
import type {
  AutomationDetail,
  AutomationReentryMode,
  AutomationTriggerKind,
} from "@/lib/automation-types";
import type { SegmentFilter, SignupForm } from "@/lib/types";
import { SegmentFilterBuilder } from "./segment-filter-builder";

// The trigger node's form. Everything about who enters this flow and whether
// they can come back is edited here, on the node that represents it, the way
// every other node is edited. These three fields live on the automation row
// rather than in the graph, so they save through the settings PATCH instead of
// the draft-graph save — the difference is plumbing and stays out of the UI.
// What is left on the Settings tab is what genuinely spans the whole flow: the
// exit condition, the From identity, and timing.

const EMPTY_ENTRY_FILTER: SegmentFilter = {
  match: "all",
  conditions: [{ field: "email", op: "contains", value: "" }],
};

export function TriggerForm({
  detail,
  forms,
  readOnly,
  onSaved,
  onSaveStatus,
  onOpenSettings,
}: {
  detail: AutomationDetail;
  forms: SignupForm[];
  readOnly: boolean;
  onSaved: (detail: AutomationDetail) => void;
  onSaveStatus: (status: SettingsSaveStatus) => void;
  onOpenSettings: () => void;
}) {
  const { queueSave, isBusy } = useAutomationSettingsSave(detail.id, onSaved, onSaveStatus);

  const [triggerKind, setTriggerKind] = useState<AutomationTriggerKind>(detail.triggerKind);
  const [triggerFormId, setTriggerFormId] = useState<string | null>(detail.triggerFormId);
  const [reentry, setReentry] = useState<AutomationReentryMode>(detail.reentry);
  // The raw filter, not the validated one: a condition mid-edit (a blank value)
  // fails the schema but must still round-trip through the builder.
  const [entry, setEntry] = useState<SegmentFilter | null>(detail.entryFilter);
  // What the server last told us the filter was. A fresh detail only overwrites
  // the local one when the server's value actually moved, so a save of some
  // other field can't wipe a condition the user is halfway through typing.
  const serverEntry = useRef(JSON.stringify(detail.entryFilter));

  // Resync from the server when nothing of ours is still in flight or waiting.
  // While something is, the local state is newer than the prop and wins.
  useEffect(() => {
    if (!isBusy()) {
      setTriggerKind(detail.triggerKind);
      setTriggerFormId(detail.triggerFormId);
      setReentry(detail.reentry);
    }
    const entryJson = JSON.stringify(detail.entryFilter);
    if (entryJson !== serverEntry.current) {
      serverEntry.current = entryJson;
      setEntry(detail.entryFilter);
    }
  }, [detail, isBusy]);

  const audienceForms = useMemo(
    () => forms.filter((f) => f.audienceId === detail.audienceId),
    [forms, detail.audienceId],
  );
  const fields = useAudienceFields(detail.audienceId, entry !== null);
  const entryComplete = useMemo(() => (entry ? completeFilter(entry) : null), [entry]);
  const entryCount = useFilterMatchCount(detail.audienceId, entryComplete);

  // The origin is only known in the browser; the placeholder keeps the snippet
  // readable during the server render.
  const [origin, setOrigin] = useState("https://day3.app");
  useEffect(() => setOrigin(window.location.origin), []);
  const enrollCurl =
    `curl -X POST ${apiBaseUrl(origin)}/automations/${detail.id}/enroll \\\n` +
    `  -H "Authorization: Bearer $DAY3_API_KEY" \\\n` +
    `  -H "Content-Type: application/json" \\\n` +
    `  -d '{"email":"jane@acme.com","attributes":{"plan":"pro"}}'`;

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

  function changeEntry(next: SegmentFilter | null) {
    setEntry(next);
    if (next === null) {
      queueSave({ entryFilter: null });
      return;
    }
    const filter = completeFilter(next);
    // Incomplete filters stay local; the line under the editor says so.
    if (filter) queueSave({ entryFilter: filter }, TEXT_DEBOUNCE_MS);
  }

  return (
    <fieldset disabled={readOnly} className="min-w-0 divide-y divide-border">
      <Section
        title="Starts when"
        hint={`Audience: ${detail.audienceName}. Set when the automation was created; for another audience, make another automation.`}
      >
        <div role="radiogroup" aria-label="Trigger" className="space-y-2">
          <ChoiceCard
            name="trigger"
            checked={triggerKind === "audience_join"}
            onSelect={() => changeTrigger("audience_join")}
            title={`When someone joins ${detail.audienceName}`}
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
              <span className="text-sm font-medium text-muted-foreground">From your backend</span>
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
          checked={entry !== null}
          onChange={(on) => changeEntry(on ? EMPTY_ENTRY_FILTER : null)}
          label="Only enroll people who match a filter"
        />
        {entry && (
          <div className="space-y-2">
            <SegmentFilterBuilder
              value={entry}
              onChange={changeEntry}
              fields={fields}
              disabled={readOnly}
            />
            <p className="text-xs text-muted-foreground tabular-nums" aria-live="polite">
              {matchCountLine(entryComplete, entryCount, "qualify")}
            </p>
          </div>
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

      <Section title="Leaving early">
        <p className="text-sm text-muted-foreground">
          {detail.exitFilter
            ? "Contacts who match the exit condition leave the flow before their next step."
            : "No exit condition is set, so everyone who enters stays until the flow ends."}{" "}
          <button
            type="button"
            onClick={onOpenSettings}
            className="underline underline-offset-2 hover:text-foreground"
          >
            {detail.exitFilter ? "Change in Settings" : "Set one in Settings"}
          </button>
          . It is checked before every step, not just this one, which is why it lives there.
        </p>
      </Section>
    </fieldset>
  );
}
