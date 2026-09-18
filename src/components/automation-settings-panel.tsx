"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { SaveIndicator, type SaveStatus } from "@/components/save-indicator";
import {
  EMPTY_FILTER,
  FilterEditor,
  TEXT_DEBOUNCE_MS,
  fromDraft,
  toDraft,
  useAudienceFields,
  useAutomationSettingsSave,
  type FilterDraft,
} from "@/components/automation-settings-shared";
import { DEFAULT_FOOTER_TEXT } from "@/services/render";
import { cn } from "@/lib/utils";
import type { AutomationDetail, SendWindow } from "@/lib/automation-types";
import type { Sender } from "@/lib/types";

// The settings that apply to the whole flow rather than to one step: who the mail
// is from, what its footer says, when it is allowed to go out, and who leaves
// early. Everything about who *enters* is edited on the trigger node in the
// canvas inspector, where the flow says it happens
// (automation-canvas/trigger-form.tsx).
//
// Laid out as a settings page rather than as a form: each group states its job in
// a left-hand rail and keeps its controls in a measured column beside it, so the
// page is scannable at a glance and no input stretches the width of the window.
// Two groups end in the result rather than in more controls: the footer as it is
// printed, the window as a sentence. Every setting here is invisible until an
// email lands, and a settings page that can show the outcome should.
//
// Every field autosaves the way the composer does: quietly, a moment after the
// last keystroke, with a toast only when the save fails. Settings apply to the
// next send for everyone, including people already in progress, because the From
// identity, footer and window are read at send time (automation-types.ts) — they
// are not part of the published graph, so they never need a publish.
//
// Prop-driven and chrome-free on purpose: the detail page decides where this sits
// (a side panel, a tab) and owns the header, the sandbox banner and the publish
// controls.

// Monday first, the way a working week is written; the values stay 0 = Sunday to
// match SendWindow.
const DAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_WINDOW: SendWindow = { days: [1, 2, 3, 4, 5], from: "09:00", to: "17:00" };

function senderVerified(s: Sender): boolean {
  return !!s.adminOverrideVerified || s.verificationStatus === "verified";
}

/* ──────────────────────────── timezone helpers ───────────────────────── */

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

// "GMT+2" for a zone, right now. Worth the work in the picker: a list of 400
// identical-looking region/city strings gives no way to tell whether the one you
// picked is the one you meant, and the offset is what people actually check.
//
// Memoized, because the picker asks for all ~400 zones at once and an Intl
// formatter each is measurable jank. Scoped to the clock hour: an offset only
// ever changes on an hour boundary (that is when DST moves), so an hour-old
// cache can't disagree with a fresh reading — which matters because this module
// renders on the server too, and a server that cached before a DST change would
// otherwise hydrate against a client that computed after it.
const offsets = new Map<string, string>();
let offsetsHour = -1;
function zoneOffset(zone: string): string {
  const hour = Math.floor(Date.now() / 3_600_000);
  if (hour !== offsetsHour) {
    offsets.clear();
    offsetsHour = hour;
  }
  const cached = offsets.get(zone);
  if (cached !== undefined) return cached;
  const value = computeZoneOffset(zone);
  offsets.set(zone, value);
  return value;
}

function computeZoneOffset(zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value ?? "";
  } catch {
    return "";
  }
}

// The zone's own clock, for the one-line readout under the picker.
function zoneTime(zone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date());
  } catch {
    return "";
  }
}

function browserTimezone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

function zoneLabel(zone: string): string {
  const offset = zoneOffset(zone);
  const name = zone.replace(/_/g, " ");
  return offset ? `${name} (${offset})` : name;
}

// Grouped by region so the list reads as a handful of continents rather than as
// 400 flat rows, with the zones the user is most likely to want pinned on top.
function groupZones(zones: string[], suggested: string[]): { label: string; zones: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const zone of zones) {
    if (suggested.includes(zone)) continue;
    const region = zone.includes("/") ? zone.slice(0, zone.indexOf("/")) : "Other";
    const bucket = groups.get(region);
    if (bucket) bucket.push(zone);
    else groups.set(region, [zone]);
  }
  const rest = [...groups.entries()]
    .map(([label, list]) => ({ label, zones: list.sort() }))
    .sort((a, b) => a.label.localeCompare(b.label));
  return suggested.length > 0 ? [{ label: "Suggested", zones: suggested }, ...rest] : rest;
}

/* ───────────────────────────── window helpers ────────────────────────── */

// "Every day" / "Mon to Fri" / "Mon, Wed, Fri" — the days as a person would say
// them, for the sentence under the picker.
function describeDays(days: number[]): string {
  const picked = DAY_ORDER.filter((d) => days.includes(d));
  if (picked.length === 0) return "No days";
  if (picked.length === 7) return "Every day";
  const indexes = picked.map((d) => DAY_ORDER.indexOf(d));
  const contiguous = indexes.every((n, i) => i === 0 || n === indexes[i - 1] + 1);
  if (contiguous && picked.length > 2) {
    return `${DAY_LABELS[picked[0]]} to ${DAY_LABELS[picked[picked.length - 1]]}`;
  }
  return picked.map((d) => DAY_LABELS[d]).join(", ");
}

/* ─────────────────────────── layout building blocks ──────────────────── */

// One settings group: its job stated once in the rail, its controls beside it.
// Single column below `md`, where a rail would only push the controls off the
// bottom of the screen.
function Group({
  title,
  description,
  children,
}: {
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-x-10 gap-y-4 py-8 first:pt-0 last:pb-0 md:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      <div className="space-y-1.5">
        <h3 className="text-sm font-medium leading-6">{title}</h3>
        <p className="text-sm leading-relaxed text-balance text-muted-foreground">{description}</p>
      </div>
      <div className="min-w-0 max-w-xl space-y-5">{children}</div>
    </section>
  );
}

function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor} className="leading-6">
        {label}
      </Label>
      {children}
      {hint && <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>}
    </div>
  );
}

// An optional setting: the switch that turns it on is the card's header, and
// what it turns on is revealed inside the same card. One box per decision, so a
// page of optional settings reads as a list rather than as a wall of controls
// that may or may not currently apply.
function OptionalSetting({
  id,
  checked,
  onChange,
  label,
  hint,
  disabled,
  children,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  hint: string;
  // A surrounding `fieldset disabled` already blocks the switch (Base UI renders
  // a button), but only the prop dims it, and a control that still looks live on
  // an archived automation invites the click it will swallow.
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border transition-colors",
        checked ? "border-border" : "border-border/60",
      )}
    >
      <div className="flex items-start justify-between gap-4 px-4 py-3.5">
        <div className="min-w-0 space-y-0.5">
          <Label htmlFor={id} className="cursor-pointer leading-6">
            {label}
          </Label>
          <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
        </div>
        <Switch
          id={id}
          checked={checked}
          onCheckedChange={onChange}
          disabled={disabled}
          aria-label={label}
          className="mt-0.5"
        />
      </div>
      {checked && (
        <div className="space-y-4 border-t border-border bg-muted/20 px-4 py-4">{children}</div>
      )}
    </div>
  );
}

// The "here is what that produces" block under a group's controls: the identity
// as a mailbox shows it, the footer as it is printed. Muted and unboxed-looking
// on purpose, so it reads as an echo of the settings rather than as more of them.
function Preview({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="rounded-lg border border-border/60 bg-muted/20 px-3.5 py-3">{children}</div>
    </div>
  );
}

/* ──────────────────────────────── the panel ──────────────────────────── */

export function AutomationSettingsPanel({
  automation,
  senders,
  companyName,
  companyAddress,
  onSaved,
}: {
  automation: AutomationDetail;
  senders: Sender[];
  // The account's own name and mailing address: not editable here, but both are
  // printed in every email this automation sends and the address is a publish
  // gate, so the footer preview shows them where the footer is written rather
  // than letting the publish dialog be the first place they are mentioned.
  companyName: string;
  companyAddress: string | null;
  onSaved: (detail: AutomationDetail) => void;
}) {
  const disabled = automation.status === "archived";
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const { queueSave, isBusy } = useAutomationSettingsSave(automation.id, onSaved, setSaveStatus);

  /* ─────────────────────────── local field state ───────────────────────── */

  const [senderId, setSenderId] = useState<string | null>(automation.senderId);
  const [replyTo, setReplyTo] = useState(automation.replyTo ?? "");
  const [footerText, setFooterText] = useState(automation.footerText ?? "");
  const [timezone, setTimezone] = useState(automation.timezone);
  const [sendWindow, setSendWindow] = useState<SendWindow | null>(automation.sendWindow);
  // The filter keeps a draft shape (strings, possibly incomplete) because a
  // half-typed condition is a legitimate state to sit in; null means "no filter".
  const [exitDraft, setExitDraft] = useState<FilterDraft | null>(
    automation.exitFilter ? toDraft(automation.exitFilter) : null,
  );
  // What the server last told us the filter was. A fresh detail only overwrites
  // the draft when the server's value actually moved, so a save of some other
  // field can't wipe a condition the user is halfway through typing.
  const serverExit = useRef(JSON.stringify(automation.exitFilter));

  // Resync from the server when nothing of ours is still in flight or waiting.
  // While something is, the local state is newer than the prop and wins.
  useEffect(() => {
    if (!isBusy()) {
      setSenderId(automation.senderId);
      setReplyTo(automation.replyTo ?? "");
      setFooterText(automation.footerText ?? "");
      setTimezone(automation.timezone);
      setSendWindow(automation.sendWindow);
    }
    const exitJson = JSON.stringify(automation.exitFilter);
    if (exitJson !== serverExit.current) {
      serverExit.current = exitJson;
      setExitDraft(automation.exitFilter ? toDraft(automation.exitFilter) : null);
    }
  }, [automation, isBusy]);

  /* ───────────────────────────── lookups ───────────────────────────────── */

  const selectedSender = senders.find((s) => s.id === senderId) ?? null;
  const senderItems = useMemo(
    () => Object.fromEntries(senders.map((s) => [s.id, `${s.fromName} <${s.fromEmail}>`])),
    [senders],
  );
  const zones = useMemo(() => timezoneOptions(timezone), [timezone]);
  const zoneItems = useMemo(
    () => Object.fromEntries(zones.map((z) => [z, zoneLabel(z)])),
    [zones],
  );
  // The browser's zone, and the clock in the chosen zone, are both client-only:
  // rendering either on the server would hydrate against a different value (a
  // different machine's zone, a different minute). Resolved in an effect, and
  // the line under the picker stays empty until they are known.
  const [localZone, setLocalZone] = useState<string | null>(null);
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    setLocalZone(browserTimezone());
    setMounted(true);
  }, []);
  const zoneGroups = useMemo(() => {
    const suggested = [timezone, ...(localZone && localZone !== timezone ? [localZone] : []), "UTC"];
    return groupZones(zones, [...new Set(suggested)].filter((z) => zones.includes(z)));
  }, [zones, timezone, localZone]);
  const fields = useAudienceFields(automation.audienceId, exitDraft !== null);

  /* ───────────────────────────── handlers ──────────────────────────────── */

  function changeExitFilter(draft: FilterDraft | null) {
    setExitDraft(draft);
    if (draft === null) {
      queueSave({ exitFilter: null });
      return;
    }
    const filter = fromDraft(draft);
    // Incomplete drafts stay local; the hint under the editor says so.
    if (filter) queueSave({ exitFilter: filter }, TEXT_DEBOUNCE_MS);
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
  const footerLine = (footerText.trim() || DEFAULT_FOOTER_TEXT).replace(
    /\{\{\s*company_name\s*\}\}/g,
    companyName || "Your company",
  );

  /* ────────────────────────────── render ───────────────────────────────── */

  return (
    // Capped: the tab sits in a card that spans the window, and a settings form
    // stretched to 1600px is unreadable. 15rem of rail plus a 36rem control
    // column is the whole page, so nothing past this width would hold anything.
    <div className="max-w-4xl">
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 pb-6">
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          These apply to every email in this automation, and take effect at each person&apos;s
          next step, including people already part-way through. They save as you type and
          don&apos;t need publishing.
        </p>
        <div className="min-h-5 pt-0.5">
          <SaveIndicator status={saveStatus} />
        </div>
      </div>

      <fieldset disabled={disabled} className="min-w-0 divide-y divide-border">
        <Group
          title="From address"
          description="The identity every email in this automation is sent from. Publishing needs one on a verified domain."
        >
          <Field
            label="Sender"
            htmlFor="automationSender"
            hint={
              senders.length > 0
                ? "Senders are shared across the account. A sender whose domain isn't verified yet can't be picked."
                : undefined
            }
          >
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
              <div className="rounded-lg border border-dashed border-border px-3.5 py-3 text-sm text-muted-foreground">
                You have no senders yet. Add one on a verified domain, then pick it here.{" "}
                <Link
                  href="/sending?tab=senders"
                  className="inline-flex items-center gap-0.5 font-medium text-foreground underline underline-offset-2"
                >
                  Add a sender
                  <ArrowUpRight className="size-3.5" />
                </Link>
              </div>
            )}
          </Field>

          <Field
            label="Reply-to"
            htmlFor="automationReplyTo"
            // Resolved, not just explained: the fallback chain ends somewhere
            // concrete, and the address a reply actually reaches is the only
            // thing anyone wants to know here.
            hint={
              !selectedSender
                ? "Where replies land. Leave blank to use the sender's own reply-to."
                : replyTo.trim()
                  ? `Replies reach ${replyTo.trim()}.`
                  : `Blank, so replies reach ${selectedSender.replyTo || selectedSender.fromEmail}, the sender's own.`
            }
          >
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
          </Field>
        </Group>

        <Group
          title="Footer"
          description="The last lines of every email this automation sends. Your mailing address and a working unsubscribe link are always printed under it."
        >
          <Field
            label="Footer text"
            htmlFor="automationFooter"
            hint="Blank uses the default wording. {{company_name}} is filled in at send."
          >
            <Textarea
              id="automationFooter"
              rows={2}
              placeholder={DEFAULT_FOOTER_TEXT}
              value={footerText}
              onChange={(e) => {
                setFooterText(e.target.value);
                queueSave({ footerText: e.target.value.trim() || null }, TEXT_DEBOUNCE_MS);
              }}
            />
          </Field>

          <Preview label="As it is printed">
            <div className="space-y-1 text-xs leading-relaxed text-muted-foreground">
              <p className="text-foreground/80">{footerLine}</p>
              {companyAddress?.trim() ? (
                <p>{companyAddress}</p>
              ) : (
                <p className="text-destructive">
                  Your business mailing address is missing. It is required by law in every email,
                  and publishing is blocked until it is set.{" "}
                  <Link
                    href="/settings"
                    className="inline-flex items-center gap-0.5 font-medium underline underline-offset-2"
                  >
                    Add it in Settings
                    <ArrowUpRight className="size-3" />
                  </Link>
                </p>
              )}
              <p className="underline underline-offset-2">Unsubscribe</p>
            </div>
          </Preview>
        </Group>

        <Group
          title="Timing"
          description="The clock this automation runs on. Wait steps count in this timezone, and so does the send window."
        >
          <Field
            label="Timezone"
            htmlFor="automationTimezone"
            hint={
              !mounted ? undefined : localZone && localZone !== timezone ? (
                <>
                  Your browser is in {localZone.replace(/_/g, " ")}.{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground underline underline-offset-2"
                    onClick={() => {
                      setTimezone(localZone);
                      queueSave({ timezone: localZone });
                    }}
                  >
                    Use that instead
                  </button>
                </>
              ) : (
                `It is ${zoneTime(timezone)} there now.`
              )
            }
          >
            <Select
              items={zoneItems}
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
                {zoneGroups.map((group) => (
                  <SelectGroup key={group.label}>
                    <SelectLabel>{group.label}</SelectLabel>
                    {group.zones.map((z) => (
                      <SelectItem key={`${group.label}-${z}`} value={z}>
                        {zoneItems[z]}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                ))}
              </SelectContent>
            </Select>
          </Field>

          <OptionalSetting
            id="windowOn"
            checked={sendWindow !== null}
            onChange={(on) => changeWindow(on ? DEFAULT_WINDOW : null)}
            label="Send window"
            hint="Hold emails for working hours instead of sending the moment a wait is up."
            disabled={disabled}
          >
            {sendWindow && (
              <>
                <div className="space-y-2">
                  <Label className="leading-6">Days</Label>
                  <div
                    role="group"
                    aria-label="Days"
                    className="grid grid-cols-7 gap-1 rounded-lg border border-input p-1"
                  >
                    {DAY_ORDER.map((d) => {
                      const on = sendWindow.days.includes(d);
                      return (
                        <button
                          key={d}
                          type="button"
                          aria-pressed={on}
                          // The last remaining day can't be switched off: a window
                          // with no days would never open and every clamped wait
                          // would hang.
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
                            "h-8 rounded-md text-xs font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none disabled:cursor-not-allowed",
                            on
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          {DAY_LABELS[d]}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="windowFrom" className="leading-6">
                    Hours
                  </Label>
                  <div className="flex flex-wrap items-center gap-2">
                    <Input
                      id="windowFrom"
                      aria-label="Window starts"
                      type="time"
                      step={900}
                      className="w-32"
                      value={sendWindow.from}
                      onChange={(e) =>
                        e.target.value && changeWindow({ ...sendWindow, from: e.target.value })
                      }
                    />
                    <span className="text-sm text-muted-foreground">to</span>
                    <Input
                      id="windowTo"
                      aria-label="Window ends"
                      type="time"
                      step={900}
                      className="w-32"
                      value={sendWindow.to}
                      onChange={(e) =>
                        e.target.value && changeWindow({ ...sendWindow, to: e.target.value })
                      }
                    />
                    <span className="text-xs text-muted-foreground">{zoneOffset(timezone)}</span>
                  </div>
                </div>

                {windowInvalid ? (
                  <p className="text-xs leading-relaxed text-destructive">
                    The window ends before it starts, so it isn&apos;t saved yet.
                  </p>
                ) : (
                  <p className="text-xs leading-relaxed text-muted-foreground">
                    A wait step set to hold for the window lands on the next open hour:{" "}
                    <span className="font-medium text-foreground">
                      {describeDays(sendWindow.days)}, {sendWindow.from} to {sendWindow.to}
                    </span>{" "}
                    in {timezone.replace(/_/g, " ")}. Steps that don&apos;t opt in still run the
                    moment they are due.
                  </p>
                )}
              </>
            )}
          </OptionalSetting>
        </Group>

        <Group
          title="Leaving early"
          description="Who stops receiving this automation before it reaches the end. Everyone else stays in until the flow runs out."
        >
          <OptionalSetting
            id="exitOn"
            checked={exitDraft !== null}
            onChange={(on) => changeExitFilter(on ? EMPTY_FILTER : null)}
            label="Remove people who match a filter"
            hint="Checked before every step, so whoever matches leaves wherever they are. 'Plan is pro' in a trial series, for instance."
            disabled={disabled}
          >
            {exitDraft && (
              <FilterEditor
                idPrefix="exit"
                audienceId={automation.audienceId}
                draft={exitDraft}
                fields={fields}
                onChange={changeExitFilter}
                subject="would leave"
              />
            )}
          </OptionalSetting>
        </Group>
      </fieldset>
    </div>
  );
}
