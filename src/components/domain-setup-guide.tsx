"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  AlertCircle,
  ArrowRight,
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
  const records = parseDnsRecords(domain.dnsRecordsJson);
  const root = registrableRoot(domain.domain);

  const [checking, setChecking] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [dnsResolved, setDnsResolved] = useState(false);
  const [hostFormat, setHostFormat] = useState<"full" | "relative">("full");
  const prevState = useRef(state);

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
        const res = await api.post<{ domain: SendingDomain; dnsResolved?: boolean }>(
          `/api/domains/${domain.id}/check`,
          {},
        );
        if (res?.domain) onChange(res.domain);
        setDnsResolved(Boolean(res?.dnsResolved));
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

  // Check once on open (fresh status, back-fills records if missing), then poll on
  // a tightening-then-steady schedule while unverified and the tab is visible,
  // plus when the user returns to the tab. The fast early ticks catch SES the
  // moment it flips (records are usually live in seconds); it then settles to a
  // gentle interval. Stops as soon as it's verified.
  useEffect(() => {
    if (verified) return;
    let cancelled = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout>;

    const scheduleNext = () => {
      if (cancelled) return;
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

    check(); // immediate, doesn't count against the backoff schedule
    scheduleNext();
    const onFocus = () => check();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [verified, check]);

  return (
    <div className="space-y-6">
      <StatusHero
        domain={domain}
        state={state}
        checking={checking}
        lastChecked={lastChecked}
        dnsResolved={dnsResolved}
        onCheck={() => check({ manual: true })}
      />

      {!verified && <CloudflareAutoConfig domain={domain} onChange={onChange} onConfigured={check} />}

      {!verified && <Steps />}

      <RecordsSection
        records={records}
        root={root}
        hostFormat={hostFormat}
        setHostFormat={setHostFormat}
        verified={verified}
        checking={checking}
        onCheck={() => check({ manual: true })}
      />

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

  return (
    <div className="rounded-xl border border-primary/20 bg-primary/5 p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <Cloud className="size-6 shrink-0 text-primary" />
          <div>
            <h3 className="font-medium">
              {connection ? "Configure DNS automatically" : "On Cloudflare? Skip the copy-paste"}
            </h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {connection
                ? `Connected${connection.label ? ` as ${connection.label}` : ""}. We'll add the records below to your Cloudflare zone for you.`
                : "Connect your Cloudflare account and we'll add these DNS records for you — no manual entry."}
            </p>
          </div>
        </div>
        <div className="shrink-0">
          {connection ? (
            <Button onClick={configure} disabled={configuring || done}>
              {configuring ? <Loader2 className="animate-spin" /> : <Zap />}
              {done ? "Records added" : configuring ? "Configuring…" : "Configure automatically"}
            </Button>
          ) : (
            <Button
              render={
                <a href={connectHref}>
                  <Cloud />
                  Connect Cloudflare
                </a>
              }
            />
          )}
        </div>
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- */

function StatusHero({
  domain,
  state,
  checking,
  lastChecked,
  dnsResolved,
  onCheck,
}: {
  domain: SendingDomain;
  state: "verified" | "pending" | "failed";
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

  const failed = state === "failed";
  // DNS records are live in public DNS but SES hasn't flipped to verified yet —
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
              ? "Your DNS records are live. We're finalizing verification with your email provider — this usually takes a few minutes, and we're checking continuously."
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

function Steps() {
  const items = [
    { n: 1, label: "Domain added", done: true, active: false },
    { n: 2, label: "Add the DNS records", done: false, active: true },
    { n: 3, label: "We verify automatically", done: false, active: false },
  ];
  return (
    <ol className="flex flex-col gap-2 sm:flex-row sm:items-center">
      {items.map((s, i) => (
        <li key={s.n} className="flex items-center gap-2 sm:flex-1">
          <span
            className={cn(
              "flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-medium",
              s.done && "bg-primary text-primary-foreground",
              s.active && "bg-primary/15 text-primary ring-2 ring-primary/30",
              !s.done && !s.active && "bg-muted text-muted-foreground",
            )}
          >
            {s.done ? <CheckCircle2 className="size-4" /> : s.n}
          </span>
          <span
            className={cn(
              "text-sm",
              s.active ? "font-medium text-foreground" : "text-muted-foreground",
            )}
          >
            {s.label}
          </span>
          {i < items.length - 1 && (
            <ArrowRight className="hidden size-4 shrink-0 text-muted-foreground/50 sm:ml-auto sm:block" />
          )}
        </li>
      ))}
    </ol>
  );
}

/* ----------------------------------------------------------------------------- */

function RecordsSection({
  records,
  root,
  hostFormat,
  setHostFormat,
  verified,
  checking,
  onCheck,
}: {
  records: DnsRecord[];
  root: string;
  hostFormat: "full" | "relative";
  setHostFormat: (f: "full" | "relative") => void;
  verified: boolean;
  checking: boolean;
  onCheck: () => void;
}) {
  const displayName = (name: string) =>
    hostFormat === "relative" ? relativeHost(name, root) : name;

  // Records aren't available yet (provider not configured, or just added).
  if (records.length === 0) {
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

  const required = records.filter((r) => r.required);
  const recommended = records.filter((r) => !r.required);
  const allAsText = records
    .map((r) => `${r.type}\t${displayName(r.name)}\t${r.value}`)
    .join("\n");

  return (
    <div className="space-y-4">
      <div>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="font-medium">{verified ? "DNS records" : "Add these DNS records"}</h3>
          {!verified && <CopyButton value={allAsText} label="Copy all" variant="outline" />}
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          Add each record at your DNS host for{" "}
          <span className="font-medium text-foreground">{root}</span>. You don&apos;t need to
          understand them — just copy each value across.
          {required.length > 1 &&
            ` DKIM uses ${required.length} similar records, so add all ${required.length}.`}
        </p>
      </div>

      <HostFormatToggle root={root} value={hostFormat} onChange={setHostFormat} />

      <div className="space-y-3">
        {required.map((r, i) => (
          <RecordCard
            key={`req-${i}`}
            record={r}
            displayName={displayName(r.name)}
            index={i + 1}
            total={required.length}
          />
        ))}
      </div>

      {recommended.length > 0 && (
        <RecommendedRecords records={recommended} displayName={displayName} />
      )}
    </div>
  );
}

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

function RecordCard({
  record,
  displayName,
  index,
  total,
}: {
  record: DnsRecord;
  displayName: string;
  index: number;
  total: number;
}) {
  return (
    <div className="rounded-lg border p-3">
      <div className="mb-2.5 flex items-center justify-between">
        <span className="text-sm font-medium">
          {total > 1 ? `Record ${index} of ${total}` : "DNS record"}
        </span>
        <Badge variant="outline" className="font-mono">
          {record.type}
        </Badge>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <CopyField label="Name / Host" value={displayName} />
        <CopyField label="Value" value={record.value} />
      </div>
    </div>
  );
}

// DMARC is optional, so it's collapsed by default to keep the required steps the
// focus — non-technical users aren't faced with an extra record up front.
function RecommendedRecords({
  records,
  displayName,
}: {
  records: DnsRecord[];
  displayName: (name: string) => string;
}) {
  return (
    <details className="group rounded-lg border bg-card">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm">
        <span className="flex items-center gap-2">
          <span className="font-medium">Add a DMARC record</span>
          <Badge variant="secondary">Optional</Badge>
        </span>
        <ChevronDown className="size-4 text-muted-foreground transition-transform group-open:rotate-180" />
      </summary>
      <div className="space-y-3 border-t p-3">
        <p className="text-xs text-muted-foreground">
          Recommended — it improves inbox placement. You can add it now or come back later.
        </p>
        {records.map((r, i) => (
          <div key={i} className="grid gap-3 sm:grid-cols-2">
            <CopyField label="Name / Host" value={displayName(r.name)} />
            <CopyField label="Value" value={r.value} />
          </div>
        ))}
      </div>
    </details>
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
            <li>Make sure the record Type matches (CNAME vs TXT) and there are no extra spaces.</li>
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
