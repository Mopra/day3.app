"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Cloud,
  Copy,
  ExternalLink,
  Loader2,
  RefreshCw,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { CopyButton, copyText } from "@/components/copy-button";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  domainState,
  parseDnsRecords,
  recheckWindowExpired,
  registrableRoot,
  relativeHost,
} from "@/lib/domain";
import type { DnsRecord, SendingDomain } from "@/lib/types";

const POLL_MS = 12_000;
// Tight early polling to catch SES the instant it verifies, then settle to POLL_MS.
const POLL_BACKOFF_MS = [3_000, 3_000, 5_000, 5_000, 8_000];

// Friendly DNS-host docs for the most common registrars non-technical users have.
const PROVIDER_DOCS: { name: string; href: string }[] = [
  { name: "GoDaddy", href: "https://www.godaddy.com/help/add-a-cname-record-19236" },
  { name: "Namecheap", href: "https://www.namecheap.com/support/knowledgebase/article.aspx/9646/2237/how-to-create-a-cname-record-for-your-domain/" },
  { name: "Cloudflare", href: "https://developers.cloudflare.com/dns/manage-dns-records/how-to/create-dns-records/" },
  { name: "Google / Squarespace", href: "https://support.google.com/domains/answer/3290350" },
];

// Live per-record DNS status as reported by /check (DoH lookups).
type DnsStatus = {
  records: { name: string; type: string; resolved: boolean }[];
  requiredResolved: boolean;
};

const recordKey = (r: { type: string; name: string }) => `${r.type}:${r.name}`;

function ago(date: Date | null): string {
  if (!date) return "";
  const s = Math.round((Date.now() - date.getTime()) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  return `${Math.floor(m / 60)}h ago`;
}

export function DomainSetupGuide({
  domain,
  onChange,
}: {
  domain: SendingDomain;
  onChange: (d: SendingDomain) => void;
}) {
  const api = useApi();
  const state = domainState(domain);
  const verified = state === "verified";
  // Pending past the cron's recheck window: the background sweep has stopped, so
  // the page must show a "needs attention" state with a manual re-check instead
  // of an indefinite spinner. We still poll while open (a manual signal of life).
  const stale = recheckWindowExpired(domain);
  const records = parseDnsRecords(domain.dnsRecordsJson);
  const root = registrableRoot(domain.domain);

  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [dns, setDns] = useState<DnsStatus>({ records: [], requiredResolved: false });
  const [hostFormat, setHostFormat] = useState<"full" | "relative">("full");
  const prevState = useRef(state);

  const resolvedByKey = useMemo(() => {
    const m = new Map<string, boolean>();
    for (const r of dns.records) m.set(recordKey(r), r.resolved);
    return m;
  }, [dns]);

  // Toast once when the domain flips to verified (from either polling or a manual
  // check), so the moment of success is unmistakable.
  useEffect(() => {
    if (prevState.current !== "verified" && state === "verified") {
      toast.success(`${domain.domain} is verified — you can send from it now.`);
    }
    prevState.current = state;
  }, [state, domain.domain]);

  const check = useCallback(
    async (opts?: { manual?: boolean }) => {
      setChecking(true);
      try {
        const res = await api.post<{ domain: SendingDomain; dns?: DnsStatus }>(
          `/api/domains/${domain.id}/check`,
          {},
        );
        if (res?.domain) onChange(res.domain);
        if (res?.dns) setDns(res.dns);
        setLastChecked(new Date());
        if (opts?.manual && res?.domain) {
          const next = domainState(res.domain);
          if (next === "pending") {
            toast.message("Still pending", {
              description: "DNS changes can take up to 48 hours to take effect.",
            });
          } else if (next === "failed") {
            toast.error("We couldn't verify the records yet. Double-check them below.");
          }
        }
      } catch (err) {
        if (opts?.manual) toast.error(err instanceof Error ? err.message : "Check failed");
      } finally {
        setChecking(false);
      }
    },
    [api, domain.id, onChange],
  );

  // Check once on open — even when already verified — to populate per-record
  // status (so verified domains show "Found", and we back-fill the Return-Path).
  // While unverified, poll on a tightening-then-steady schedule and on tab focus;
  // the fast early ticks catch SES the moment it flips. Stops once verified.
  useEffect(() => {
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      if (cancelled || verified) return;
      const delay = attempt < POLL_BACKOFF_MS.length ? POLL_BACKOFF_MS[attempt] : POLL_MS;
      timer = setTimeout(run, delay);
    };
    const run = async () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        await check();
        attempt += 1;
      }
      scheduleNext();
    };

    check(); // immediate, once — doesn't count against the backoff schedule
    if (verified) {
      return () => {
        cancelled = true;
        clearTimeout(timer);
      };
    }
    scheduleNext();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [verified, check]);

  const verifyRecords = records.filter((r) => (r.group ?? "verify") === "verify");
  const deliverabilityRecords = records.filter((r) => (r.group ?? "verify") === "deliverability");
  const dmarcRecords = deliverabilityRecords.filter((r) => r.name.startsWith("_dmarc"));
  const returnPathRecords = deliverabilityRecords.filter((r) => !r.name.startsWith("_dmarc"));

  // The optional Return-Path is "done" once SES confirms it; until then there's
  // still DNS to add, so keep the one-click helper around (it writes every record
  // including the Return-Path), even for an otherwise-verified domain.
  const fullyConfigured = verified && domain.mailFromStatus === "success";
  const displayName = (name: string) =>
    hostFormat === "relative" ? relativeHost(name, root) : name;

  return (
    <div className="space-y-6">
      <StatusHero
        domain={domain}
        state={state}
        stale={stale}
        checking={checking}
        lastChecked={lastChecked}
        dnsResolved={dns.requiredResolved}
        onCheck={() => check({ manual: true })}
      />

      {domain.dnsWriteError && !verified && <DnsWriteErrorNotice error={domain.dnsWriteError} />}

      {!fullyConfigured && (
        <CloudflareAutoConfig domain={domain} onChange={onChange} onConfigured={check} />
      )}

      {verifyRecords.length === 0 ? (
        <RecordsNotReady checking={checking} onCheck={() => check({ manual: true })} />
      ) : (
        <>
          <HostFormatToggle root={root} value={hostFormat} onChange={setHostFormat} />

          <ChecklistSection
            title={verified ? "Domain verification" : "Verify your domain"}
            subtitle={
              <>
                These DKIM records prove you own{" "}
                <span className="font-medium text-foreground">{root}</span> and let inboxes trust
                your mail. You don&apos;t need to understand them — just copy each value across.
              </>
            }
            records={verifyRecords}
            resolvedByKey={resolvedByKey}
            displayName={displayName}
            showCopyAll
          />

          {deliverabilityRecords.length > 0 && (
            <DeliverabilitySection
              returnPath={returnPathRecords}
              dmarc={dmarcRecords}
              resolvedByKey={resolvedByKey}
              displayName={displayName}
              mailFromStatus={domain.mailFromStatus}
            />
          )}
        </>
      )}

      <HelpSection root={root} />
    </div>
  );
}

/* ----------------------------------------------------------------------------- */

type CfConnection = { status: string; label: string | null; scope: string | null; connectedAt: string };
type CfWriteResult = {
  record: { name: string; type: string };
  action: "created" | "updated" | "skipped" | "error";
  error?: string;
};

// One-click DNS for Cloudflare users: connect via OAuth, then we write the
// records into their zone. Falls back to the manual record cards below for
// everyone else. After a fresh connect we auto-run the write so it's truly
// one-click (the connect redirect lands back here with ?cf_connected=1).
function CloudflareAutoConfig({
  domain,
  onChange,
  onConfigured,
}: {
  domain: SendingDomain;
  onChange: (d: SendingDomain) => void;
  onConfigured: () => void;
}) {
  const api = useApi();
  const router = useRouter();
  const searchParams = useSearchParams();
  const [connection, setConnection] = useState<CfConnection | null | undefined>(undefined);
  const [configuring, setConfiguring] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [done, setDone] = useState(false);

  const loadConnection = useCallback(async () => {
    try {
      const res = await api.get<{ connection: CfConnection | null }>("/api/integrations/cloudflare");
      setConnection(res.connection);
      return res.connection;
    } catch {
      setConnection(null);
      return null;
    }
  }, [api]);

  const configure = useCallback(async () => {
    setConfiguring(true);
    try {
      const res = await api.post<{ domain: SendingDomain; results: CfWriteResult[] }>(
        `/api/domains/${domain.id}/auto-configure`,
        {},
      );
      if (res?.domain) onChange(res.domain);
      const errors = res.results.filter((r) => r.action === "error");
      if (errors.length) {
        toast.error(`Some records couldn't be written: ${errors[0].error}`);
        return;
      }
      const written = res.results.filter((r) => r.action !== "skipped").length;
      toast.success(
        written > 0
          ? `Added ${written} DNS record${written === 1 ? "" : "s"} to Cloudflare — verifying now.`
          : "Your Cloudflare DNS is already set up — verifying now.",
      );
      setDone(true);
      onConfigured();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't configure Cloudflare");
    } finally {
      setConfiguring(false);
    }
  }, [api, domain.id, onChange, onConfigured]);

  const disconnect = useCallback(async () => {
    setDisconnecting(true);
    try {
      await api.del("/api/integrations/cloudflare");
      setConnection(null);
      setDone(false);
      toast.success("Cloudflare disconnected.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't disconnect Cloudflare");
    } finally {
      setDisconnecting(false);
    }
  }, [api]);

  useEffect(() => {
    loadConnection();
  }, [loadConnection]);

  // Handle the redirect back from Cloudflare's consent screen.
  const handledReturn = useRef(false);
  useEffect(() => {
    if (handledReturn.current) return;
    const error = searchParams.get("cf_error");
    const connected = searchParams.get("cf_connected");
    if (!error && !connected) return;
    handledReturn.current = true;
    router.replace(`/domains/${domain.id}`); // drop the query so a refresh doesn't re-fire
    if (error) {
      toast.error(error);
      return;
    }
    toast.success("Cloudflare connected.");
    loadConnection().then((conn) => {
      if (conn) configure();
    });
  }, [searchParams, router, domain.id, loadConnection, configure]);

  if (connection === undefined) return null; // avoid a flash before we know the state

  const connectHref = `/api/integrations/cloudflare/connect?returnTo=${encodeURIComponent(`/domains/${domain.id}`)}`;

  // A connection whose token expired and can't be refreshed needs the user to
  // re-consent (see CloudflareReauthRequiredError on the server). Treat anything
  // other than "connected" as needing a reconnect rather than offering an action
  // that will just fail.
  const expired = connection != null && connection.status !== "connected";

  const heading = !connection
    ? "On Cloudflare? Skip the copy-paste"
    : expired
      ? "Reconnect Cloudflare to continue"
      : "Configure DNS automatically";

  const description = !connection
    ? "Connect your Cloudflare account and we'll add these DNS records for you — no manual entry."
    : expired
      ? "Your Cloudflare connection expired. Reconnect to let us add these DNS records for you again."
      : `Connected${connection.label ? ` as ${connection.label}` : ""}. We'll add every record below to your Cloudflare zone for you.`;

  const reconnectButton = (
    <Button
      variant={expired ? "default" : "outline"}
      render={
        <a href={connectHref}>
          <Cloud />
          {connection ? "Reconnect Cloudflare" : "Connect Cloudflare"}
        </a>
      }
    />
  );

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Cloud className="size-6 shrink-0 text-primary" />
          <div>
            <h3 className="font-medium">{heading}</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {connection && !expired && (
            <Button onClick={configure} disabled={configuring || done}>
              {configuring ? <Loader2 className="animate-spin" /> : <Zap />}
              {done ? "Records added" : configuring ? "Configuring…" : "Configure automatically"}
            </Button>
          )}
          {(expired || !connection) && reconnectButton}
          {connection && (
            <Button variant="ghost" size="sm" onClick={disconnect} disabled={disconnecting}>
              {disconnecting ? <Loader2 className="animate-spin" /> : null}
              Disconnect
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- */

// Surfaced when a Cloudflare auto-configure write failed (dnsWriteError persisted
// on the row). The toast at write time is transient; this keeps the failure and
// its manual fallback visible until the records actually verify.
function DnsWriteErrorNotice({ error }: { error: string }) {
  return (
    <div className="flex flex-col gap-3 rounded-xl border border-amber-500/40 bg-amber-500/5 p-5 sm:flex-row sm:items-start">
      <AlertCircle className="size-6 shrink-0 text-amber-500" />
      <div className="space-y-1">
        <h3 className="font-medium">Automatic DNS setup didn&apos;t finish</h3>
        <p className="text-sm text-muted-foreground">
          We couldn&apos;t write every record to Cloudflare automatically
          {error ? <> — {error}.</> : "."} You can retry the one-click setup below, or add the
          records yourself using the values further down. Either path verifies the domain.
        </p>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- */

function StatusHero({
  domain,
  state,
  stale,
  checking,
  lastChecked,
  dnsResolved,
  onCheck,
}: {
  domain: SendingDomain;
  state: "verified" | "pending" | "failed";
  stale: boolean;
  checking: boolean;
  lastChecked: Date | null;
  dnsResolved: boolean;
  onCheck: () => void;
}) {
  if (state === "verified") {
    return (
      <div className="flex flex-col gap-3 rounded-xl border border-primary/20 bg-primary/5 p-5 sm:flex-row sm:items-center">
        <CheckCircle2 className="size-8 shrink-0 text-primary" />
        <div className="flex-1">
          <h2 className="font-medium">Your domain is verified</h2>
          <p className="text-sm text-muted-foreground">
            Campaigns can now be sent from{" "}
            <span className="font-medium text-foreground">
              {domain.fromEmail ?? domain.domain}
            </span>
            {domain.adminOverrideVerified && domain.verificationStatus !== "verified"
              ? " (verified by support)."
              : "."}
          </p>
        </div>
      </div>
    );
  }

  // Pending and past the automatic recheck window: the background sweep has
  // stopped, so this domain would otherwise spin forever. Tell the user plainly
  // and give them the manual re-check that restarts the cycle (a successful
  // re-check bumps updatedAt back inside the window).
  if (stale) {
    return (
      <div className="flex flex-col gap-4 rounded-xl border border-amber-500/40 bg-amber-500/5 p-5 sm:flex-row sm:items-start">
        <AlertCircle className="size-8 shrink-0 text-amber-500" />
        <div className="flex-1 space-y-1">
          <h2 className="font-medium">This domain needs your attention</h2>
          <p className="text-sm text-muted-foreground">
            It&apos;s been pending for more than two weeks, so we&apos;ve paused the automatic
            checks. If you&apos;ve since added the DNS records below, run a re-check now and
            we&apos;ll pick verification back up. Otherwise, add the records and re-check.
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
            {checking ? (
              <span className="flex items-center gap-1.5">
                <Loader2 className="size-3 animate-spin" /> Checking now…
              </span>
            ) : lastChecked ? (
              <span>Last checked {ago(lastChecked)}</span>
            ) : null}
          </div>
        </div>
        <Button onClick={onCheck} disabled={checking} className="shrink-0">
          {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Re-check now
        </Button>
      </div>
    );
  }

  const failed = state === "failed";
  // DKIM records are live in public DNS but SES hasn't flipped to verified yet —
  // the part we control is done, so say so instead of a generic "waiting".
  const confirmed = !failed && dnsResolved;
  return (
    <div
      className={cn(
        "flex flex-col gap-4 rounded-xl border p-5 sm:flex-row sm:items-start",
        failed
          ? "border-destructive/30 bg-destructive/5"
          : confirmed
            ? "border-primary/20 bg-primary/5"
            : "bg-muted/40",
      )}
    >
      {failed ? (
        <AlertCircle className="size-8 shrink-0 text-destructive" />
      ) : confirmed ? (
        <CheckCircle2 className="size-8 shrink-0 text-primary" />
      ) : (
        <Loader2 className="size-8 shrink-0 animate-spin text-muted-foreground" />
      )}
      <div className="flex-1 space-y-1">
        <h2 className="font-medium">
          {failed
            ? "We couldn't verify this domain yet"
            : confirmed
              ? "DNS records confirmed — finalizing"
              : "Waiting for your DNS records"}
        </h2>
        <p className="text-sm text-muted-foreground">
          {failed
            ? "The records below may be missing or mistyped. Fix them at your DNS host and we'll keep checking automatically."
            : confirmed
              ? "Your DKIM records are live. We're finalizing verification with your email provider — this usually takes a few minutes, and we're checking continuously."
              : "Add the DNS records below at your domain host. We check automatically every few minutes — most domains verify within an hour, though DNS can take up to 48 hours."}
        </p>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-1 text-xs text-muted-foreground">
          {checking ? (
            <span className="flex items-center gap-1.5">
              <Loader2 className="size-3 animate-spin" /> Checking now…
            </span>
          ) : lastChecked ? (
            <span>Last checked {ago(lastChecked)}</span>
          ) : (
            <span>Checking automatically…</span>
          )}
        </div>
      </div>
      <Button variant="outline" onClick={onCheck} disabled={checking} className="shrink-0">
        {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        Check now
      </Button>
    </div>
  );
}

/* ----------------------------------------------------------------------------- */

// Records aren't available yet (provider not configured, or just added).
function RecordsNotReady({ checking, onCheck }: { checking: boolean; onCheck: () => void }) {
  return (
    <div className="rounded-xl border border-dashed p-6 text-center">
      <p className="text-sm font-medium">DNS records aren&apos;t ready yet</p>
      <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
        We&apos;re still fetching the records for this domain from the email provider.
        This usually takes a moment.
      </p>
      <Button variant="outline" onClick={onCheck} disabled={checking} className="mt-3">
        {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        Refresh
      </Button>
    </div>
  );
}

/* ----------------------------------------------------------------------------- */

// A status-led checklist of DNS records. The header shows running progress
// ("X of Y found") so a non-technical user always knows what's left.
function ChecklistSection({
  title,
  subtitle,
  records,
  resolvedByKey,
  displayName,
  showCopyAll,
}: {
  title: string;
  subtitle?: ReactNode;
  records: DnsRecord[];
  resolvedByKey: Map<string, boolean>;
  displayName: (name: string) => string;
  showCopyAll?: boolean;
}) {
  const found = records.filter((r) => resolvedByKey.get(recordKey(r))).length;
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium">{title}</h3>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className="text-xs text-muted-foreground">
            {found} of {records.length} found
          </span>
          {showCopyAll && (
            <CopyButton value={copyAllText(records, displayName)} label="Copy all" variant="outline" />
          )}
        </div>
      </div>
      <div className="space-y-3">
        {records.map((r) => (
          <RecordRow
            key={recordKey(r)}
            record={r}
            displayName={displayName(r.name)}
            resolved={!!resolvedByKey.get(recordKey(r))}
          />
        ))}
      </div>
    </section>
  );
}

// The optional deliverability group: the custom Return-Path (MX + SPF) shown up
// front, with DMARC tucked into a collapsible so the required steps stay the
// focus. The header carries SES's own Return-Path status.
function DeliverabilitySection({
  returnPath,
  dmarc,
  resolvedByKey,
  displayName,
  mailFromStatus,
}: {
  returnPath: DnsRecord[];
  dmarc: DnsRecord[];
  resolvedByKey: Map<string, boolean>;
  displayName: (name: string) => string;
  mailFromStatus?: string;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="flex items-center gap-2 font-medium">
            Improve deliverability
            <Badge variant="secondary">Optional</Badge>
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            A custom Return-Path and DMARC strengthen SPF/DMARC alignment, so more of your mail
            lands in the inbox. Add these now or come back later.
          </p>
        </div>
        {returnPath.length > 0 && <ReturnPathStatus status={mailFromStatus} />}
      </div>

      {returnPath.length > 0 && (
        <div className="space-y-3">
          {returnPath.map((r) => (
            <RecordRow
              key={recordKey(r)}
              record={r}
              displayName={displayName(r.name)}
              resolved={!!resolvedByKey.get(recordKey(r))}
            />
          ))}
        </div>
      )}

      {dmarc.length > 0 && (
        <details className="group rounded-lg border bg-card">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm">
            <span className="flex items-center gap-2">
              <span className="font-medium">Add a DMARC record</span>
              <Badge variant="secondary">Recommended</Badge>
            </span>
            <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
          </summary>
          <div className="space-y-3 border-t p-3">
            <p className="text-xs text-muted-foreground">
              Recommended — it improves inbox placement. You can add it now or come back later.
            </p>
            {dmarc.map((r) => (
              <RecordRow
                key={recordKey(r)}
                record={r}
                displayName={displayName(r.name)}
                resolved={!!resolvedByKey.get(recordKey(r))}
              />
            ))}
          </div>
        </details>
      )}
    </section>
  );
}

function ReturnPathStatus({ status }: { status?: string }) {
  const ok = status === "success";
  const broken = status === "failed" || status === "temporary_failure";
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium",
        ok
          ? "border-primary/30 bg-primary/10 text-primary"
          : broken
            ? "border-destructive/30 bg-destructive/5 text-destructive"
            : "text-muted-foreground",
      )}
    >
      {ok ? (
        <Check className="size-3.5" />
      ) : broken ? (
        <AlertCircle className="size-3.5" />
      ) : (
        <Loader2 className="size-3.5 animate-spin" />
      )}
      Return-Path {ok ? "active" : broken ? "needs attention" : "pending"}
    </span>
  );
}

// A single record as a checklist item: status pill first, then the big
// click-to-copy Name and Value. MX rows surface their priority.
function RecordRow({
  record,
  displayName,
  resolved,
}: {
  record: DnsRecord;
  displayName: string;
  resolved: boolean;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2.5 flex flex-wrap items-center gap-2">
        <StatusPill resolved={resolved} />
        <Badge variant="outline" className="font-mono">
          {record.type}
        </Badge>
        {record.description && (
          <span className="text-sm text-muted-foreground">{record.description}</span>
        )}
        {record.type === "MX" && record.priority != null && (
          <Badge variant="secondary">Priority {record.priority}</Badge>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <CopyField label="Name / Host" value={displayName} />
        <CopyField label="Value" value={record.value} />
      </div>
    </div>
  );
}

function StatusPill({ resolved }: { resolved: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-medium",
        resolved
          ? "border-primary/30 bg-primary/10 text-primary"
          : "text-muted-foreground",
      )}
    >
      {resolved ? (
        <Check className="size-3.5" />
      ) : (
        <Loader2 className="size-3.5 animate-spin" />
      )}
      {resolved ? "Found" : "Waiting"}
    </span>
  );
}

// Tab-separated dump of every record for the "Copy all" button. Includes MX
// priority so DNS hosts that ask for it as a separate field get the value.
function copyAllText(records: DnsRecord[], displayName: (name: string) => string): string {
  return records
    .map((r) => {
      const parts = [r.type, displayName(r.name), r.value];
      if (r.type === "MX" && r.priority != null) parts.push(String(r.priority));
      return parts.join("\t");
    })
    .join("\n");
}

/* ----------------------------------------------------------------------------- */

function HostFormatToggle({
  root,
  value,
  onChange,
}: {
  root: string;
  value: "full" | "relative";
  onChange: (f: "full" | "relative") => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg bg-muted/40 p-2.5 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">
        Some DNS hosts want the full record name; others want only the part before{" "}
        <span className="font-medium text-foreground">{root}</span>.
      </p>
      <div className="inline-flex shrink-0 rounded-md border bg-background p-0.5 text-xs">
        {(["full", "relative"] as const).map((opt) => (
          <button
            key={opt}
            type="button"
            onClick={() => onChange(opt)}
            className={cn(
              "rounded px-2.5 py-1 font-medium transition-colors",
              value === opt
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {opt === "full" ? "Full name" : "Subdomain only"}
          </button>
        ))}
      </div>
    </div>
  );
}

// A whole-field click-to-copy control. The long DNS value is truncated (no
// scrollbars to fight) and the entire box is the copy target, with clear
// feedback — the value is something you copy, not something you read.
function CopyField({ label, value }: { label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  async function onCopy() {
    if (!(await copyText(value))) return;
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="min-w-0 space-y-1">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <button
        type="button"
        onClick={onCopy}
        title={value}
        className="group/field flex w-full min-w-0 items-center gap-2 rounded-md border bg-muted/40 py-2 pr-2 pl-2.5 text-left transition-colors hover:bg-muted"
      >
        <code className="min-w-0 flex-1 truncate font-mono text-xs">{value}</code>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 text-xs font-medium",
            copied ? "text-primary" : "text-muted-foreground group-hover/field:text-foreground",
          )}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy"}
        </span>
      </button>
    </div>
  );
}

/* ----------------------------------------------------------------------------- */

function HelpSection({ root }: { root: string }) {
  return (
    <details className="group rounded-xl border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-medium">
        Need help adding these records?
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-4 border-t px-4 py-4 text-sm text-muted-foreground">
        <div>
          <p className="font-medium text-foreground">Where do these go?</p>
          <p className="mt-1">
            Sign in to wherever you bought or manage{" "}
            <span className="font-medium text-foreground">{root}</span> and open its DNS settings.
            Add each record above with its Type, Name/Host, and Value. Leave TTL at the default.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {PROVIDER_DOCS.map((p) => (
              <a
                key={p.name}
                href={p.href}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs text-foreground transition-colors hover:bg-muted"
              >
                {p.name}
                <ExternalLink className="size-3" />
              </a>
            ))}
          </div>
        </div>
        <div>
          <p className="font-medium text-foreground">Still pending after a while?</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            <li>DNS changes can take up to 48 hours to spread across the internet.</li>
            <li>
              If your host added your domain to the Name automatically, switch to{" "}
              <span className="font-medium text-foreground">Subdomain only</span> above so the
              name isn&apos;t duplicated (e.g. <code>…_domainkey.{root}.{root}</code>).
            </li>
            <li>Make sure the record Type matches (CNAME, TXT, or MX) and there are no extra spaces.</li>
            <li>
              The Return-Path uses a <span className="font-medium text-foreground">send</span> host
              and an MX record — that&apos;s expected, and it&apos;s what improves deliverability.
            </li>
            <li>Don&apos;t add quotes around CNAME values — only some TXT records use them.</li>
          </ul>
        </div>
        <div>
          <p className="font-medium text-foreground">Why is this needed?</p>
          <p className="mt-1">
            These records prove you own the domain and let inbox providers trust your emails, so
            your campaigns land in the inbox instead of spam.
          </p>
        </div>
      </div>
    </details>
  );
}
