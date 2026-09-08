"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Archive, Pause, Play, Rocket } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RowActions } from "@/components/ui/data-list";
import { MenuItem } from "@/components/ui/menu";
import { CollapsibleNotice } from "@/components/ui/notice";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AutomationSettingsPanel } from "@/components/automation-settings-panel";
import { AutomationCanvas, type SaveStatus } from "@/components/automation-canvas/canvas";
import { EnrollmentsTab } from "@/components/automation-canvas/enrollments-tab";
import { PublishDialog } from "@/components/automation-canvas/publish-dialog";
import { StatsTable } from "@/components/automation-canvas/stats-table";
import { SandboxBadge } from "@/components/sandbox-notice";
import { AutomationStatusBadge } from "@/components/ui/status-badge";
import { useApi } from "@/lib/api";
import type { GraphValidation } from "@/lib/automation-graph";
import type { AutomationDetail, AutomationStats } from "@/lib/automation-types";
import type { Audience, Sender, SignupForm } from "@/lib/types";

export type TabKey = "canvas" | "settings" | "people" | "stats";
const TABS: TabKey[] = ["canvas", "settings", "people", "stats"];

// The server page hands over whatever ?tab= said; anything else opens the canvas.
export function parseTab(value: string | undefined): TabKey {
  return value && TABS.includes(value as TabKey) ? (value as TabKey) : "canvas";
}

// Live numbers refresh on this cadence while the automation runs and the tab is
// in front. Slow enough to be free, fast enough that "12 waiting here" is true.
const POLL_MS = 15_000;

export function AutomationView({
  initialDetail,
  initialTab,
  audiences,
  senders,
  forms,
}: {
  initialDetail: AutomationDetail;
  initialTab: TabKey;
  audiences: Audience[];
  senders: Sender[];
  forms: SignupForm[];
}) {
  const api = useApi();
  const router = useRouter();
  const [detail, setDetail] = useState(initialDetail);
  useEffect(() => setDetail(initialDetail), [initialDetail]);

  // ?tab= keeps a deep link (and a refresh) on the same tab. Read on the server
  // and passed in, so a deep link to Settings never mounts the canvas first
  // (React Flow's measuring pass and a possible autosave) only to unmount it.
  const [tab, setTab] = useState<TabKey>(initialTab);
  function changeTab(next: TabKey) {
    setTab(next);
    const url = new URL(window.location.href);
    if (next === "canvas") url.searchParams.delete("tab");
    else url.searchParams.set("tab", next);
    window.history.replaceState(null, "", url);
  }

  /* ─────────────────────────────── stats ──────────────────────────────── */

  const [stats, setStats] = useState<AutomationStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    try {
      const s = await api.get<AutomationStats>(`/api/automations/${detail.id}/stats`);
      setStats(s);
      setDetail((d) => ({ ...d, counts: s.counts }));
    } catch {
      // A missed poll is not worth a toast; the next one will land.
    } finally {
      setStatsLoading(false);
    }
  }, [api, detail.id]);

  const published = !!detail.liveVersion;
  useEffect(() => {
    if (!published) return;
    void loadStats();
    if (detail.status !== "active") return;
    const t = setInterval(() => {
      if (document.visibilityState === "visible") void loadStats();
    }, POLL_MS);
    return () => clearInterval(t);
  }, [published, detail.status, loadStats]);

  /* ─────────────────────────────── header ─────────────────────────────── */

  const [name, setName] = useState(detail.name);
  useEffect(() => setName(detail.name), [detail.name]);
  const [busy, setBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [publishOpen, setPublishOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [focusNodeKey, setFocusNodeKey] = useState<string | null>(null);
  const [serverValidation, setServerValidation] = useState<GraphValidation | null>(null);
  const nameInput = useRef<HTMLInputElement>(null);

  async function saveName() {
    const next = name.trim();
    if (!next) {
      setName(detail.name);
      return;
    }
    if (next === detail.name) return;
    try {
      const updated = await api.patch<AutomationDetail>(`/api/automations/${detail.id}`, { name: next });
      setDetail(updated);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't rename");
      setName(detail.name);
    }
  }

  async function action(path: "pause" | "resume", success: string) {
    setBusy(true);
    try {
      const updated = await api.post<AutomationDetail>(`/api/automations/${detail.id}/${path}`);
      setDetail(updated);
      toast.success(success);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Action failed");
    } finally {
      setBusy(false);
    }
  }

  const [archiving, setArchiving] = useState(false);
  async function archive() {
    setArchiving(true);
    try {
      await api.del(`/api/automations/${detail.id}`);
      toast.success(published ? "Automation archived" : "Draft deleted");
      router.push("/automations");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't archive");
      setArchiving(false);
    }
  }

  // Any edit to the graph invalidates a stale server verdict.
  function onDetailChange(updated: AutomationDetail) {
    setDetail(updated);
    setServerValidation(null);
    setFocusNodeKey(null);
  }

  const archived = detail.status === "archived";
  const live = detail.liveVersion;
  const canPublish = !archived && (!live || detail.draftDirty);
  const saving = saveStatus === "pending" || saveStatus === "saving";
  const versionText = !live
    ? "Not published yet"
    : detail.draftDirty
      ? `v${live.version} live, draft has changes`
      : `v${live.version} live`;
  const inFlight = detail.counts.active + detail.counts.sending;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          {/* Auto-sizing title input: the sizer span mirrors the text so the
              badges hug the name instead of being pushed to the far edge. */}
          <div className="grid min-w-0 max-w-full items-center font-display text-2xl sm:text-3xl">
            <span
              aria-hidden
              className="invisible col-start-1 row-start-1 min-w-[6rem] max-w-full whitespace-pre"
            >
              {name || "Untitled automation"}
            </span>
            <input
              ref={nameInput}
              aria-label="Automation name"
              size={1}
              className="col-start-1 row-start-1 w-full min-w-0 truncate border-0 bg-transparent p-0 outline-none placeholder:text-muted-foreground/40 focus-visible:ring-0"
              placeholder="Untitled automation"
              value={name}
              disabled={archived}
              onChange={(e) => setName(e.target.value)}
              onBlur={saveName}
              onKeyDown={(e) => {
                if (e.key === "Enter") nameInput.current?.blur();
                if (e.key === "Escape") {
                  setName(detail.name);
                  requestAnimationFrame(() => nameInput.current?.blur());
                }
              }}
            />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <AutomationStatusBadge status={detail.status} />
            {detail.sandbox && <SandboxBadge />}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          <span className="text-xs text-muted-foreground">{versionText}</span>
          {canPublish && (
            <Button disabled={busy || saving} onClick={() => setPublishOpen(true)}>
              <Rocket />
              {live ? "Publish changes" : "Publish"}
            </Button>
          )}
          {detail.status === "active" && (
            <Button variant="outline" disabled={busy} onClick={() => action("pause", "Paused")}>
              <Pause />
              Pause
            </Button>
          )}
          {detail.status === "paused" && (
            <Button
              variant={canPublish ? "outline" : "default"}
              disabled={busy}
              onClick={() => action("resume", "Resumed")}
            >
              <Play />
              Resume
            </Button>
          )}
          {!archived && (
            <RowActions label="More">
              <MenuItem variant="destructive" disabled={busy} onClick={() => setArchiveOpen(true)}>
                <Archive />
                {published ? "Archive" : "Delete draft"}
              </MenuItem>
            </RowActions>
          )}
        </div>
      </div>

      {archived && (
        <CollapsibleNotice noticeKey="automation-archived" title="This automation is archived">
          It no longer enrolls anyone and everyone who was in it has left. The canvas is kept
          for reference.
        </CollapsibleNotice>
      )}

      {detail.status === "paused" && (
        <CollapsibleNotice noticeKey="automation-paused" title="Paused">
          Nobody new enters and nobody mid-flight moves on until you resume.
          {inFlight > 0 && ` ${inFlight.toLocaleString()} ${inFlight === 1 ? "person is" : "people are"} waiting.`}
        </CollapsibleNotice>
      )}

      <Tabs value={tab} onValueChange={(v) => changeTab(v as TabKey)}>
        <TabsList>
          <TabsTrigger value="canvas">Canvas</TabsTrigger>
          <TabsTrigger value="settings">Settings</TabsTrigger>
          <TabsTrigger value="people">
            People
            {detail.counts.total > 0 && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {detail.counts.total.toLocaleString()}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="stats">Stats</TabsTrigger>
        </TabsList>
      </Tabs>

      {tab === "canvas" && (
        <AutomationCanvas
          detail={detail}
          stats={stats}
          onDetailChange={onDetailChange}
          onSaveStatus={setSaveStatus}
          onOpenSettings={() => changeTab("settings")}
          focusNodeKey={focusNodeKey}
          serverValidation={serverValidation}
          readOnly={archived}
        />
      )}
      {tab === "settings" && (
        <AutomationSettingsPanel
          automation={detail}
          audiences={audiences}
          senders={senders}
          forms={forms}
          onSaved={setDetail}
        />
      )}
      {tab === "people" && <EnrollmentsTab detail={detail} onCountsChanged={() => void loadStats()} />}
      {tab === "stats" && (
        <StatsTable stats={stats} graph={detail.live ?? detail.draft} loading={statsLoading} />
      )}

      <PublishDialog
        open={publishOpen}
        onOpenChange={setPublishOpen}
        detail={detail}
        serverValidation={serverValidation}
        onPublished={(updated) => {
          setDetail(updated);
          setServerValidation(null);
          void loadStats();
        }}
        onFailure={(validation) => {
          setServerValidation(validation);
          const first = validation.errors.find((e) => e.nodeKey)?.nodeKey ?? null;
          setFocusNodeKey(first);
          if (first) {
            setPublishOpen(false);
            changeTab("canvas");
          }
        }}
      />

      <ConfirmDialog
        open={archiveOpen}
        onOpenChange={setArchiveOpen}
        title={published ? "Archive this automation?" : "Delete this draft?"}
        description={
          published
            ? `Nobody new enters and everyone still in it leaves right away${
                inFlight > 0 ? ` (${inFlight.toLocaleString()} ${inFlight === 1 ? "person" : "people"} right now)` : ""
              }. The canvas and its numbers stay readable.`
            : "It has never been published, so there is nothing to keep."
        }
        confirmLabel={published ? "Archive" : "Delete"}
        busy={archiving}
        onConfirm={archive}
      />
    </div>
  );
}
