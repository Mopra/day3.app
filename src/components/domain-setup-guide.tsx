"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  RefreshCw,
  Zap,
} from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { copyText } from "@/components/copy-button";
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
  // Always show the relative ("subdomain only") form: it's what the hosted DNS
  // dashboards the vast majority of users have (Cloudflare, GoDaddy, Namecheap,
  // Route 53, Google) expect — they append the zone themselves. Pasting the full
  // name into those would double the zone and silently fail to verify, so we
  // don't offer it as a choice; raw zone-file hosts can append the zone manually.
  const [selectedStep, setSelectedStep] = useState<1 | 2 | 3>(1);
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

  // The step the user should be looking at, derived from real state: step 1 (add
  // records) until the required DKIM records resolve in public DNS, then step 2
  // (verification) carries the rest — it owns the finalizing, failed, stale, and
  // verified states, which are all "what's the status" concerns, not "do this".
  const currentStep: 1 | 2 = verified || stale || state === "failed" || dns.requiredResolved ? 2 : 1;

  // Auto-advance the selected step when real progress moves currentStep — but
  // never fight a manual selection that didn't cross a threshold (clicking back
  // to review the records while pending stays put until DNS actually resolves).
  const lastCurrentStep = useRef(0);
  useEffect(() => {
    if (lastCurrentStep.current !== currentStep) {
      lastCurrentStep.current = currentStep;
      setSelectedStep(currentStep);
    }
  }, [currentStep]);

  const verifyRecords = records.filter((r) => (r.group ?? "verify") === "verify");
  const deliverabilityRecords = records.filter((r) => (r.group ?? "verify") === "deliverability");
  const dmarcRecords = deliverabilityRecords.filter((r) => r.name.startsWith("_dmarc"));
  const returnPathRecords = deliverabilityRecords.filter((r) => !r.name.startsWith("_dmarc"));

  // The optional Return-Path is "done" once SES confirms it; until then there's
  // still DNS to add, so keep the one-click helper around (it writes every record
  // including the Return-Path), even for an otherwise-verified domain.
  const fullyConfigured = verified && domain.mailFromStatus === "success";
  const displayName = (name: string) => relativeHost(name, root);

  const hasDeliverability = deliverabilityRecords.length > 0;
  const totalSteps = hasDeliverability ? 3 : 2;

  // Per-step state for the rail. The dot encodes progress; selection is separate
  // (handled in StepRail), so a user can review a completed step without it
  // looking unfinished.
  const steps: StepItem[] = [
    {
      n: 1,
      title: "Add DNS records",
      hint:
        verified || dns.requiredResolved
          ? "Records detected"
          : state === "failed"
            ? "Needs a fix"
            : "Copy them to your DNS host",
      status:
        verified || dns.requiredResolved
          ? "complete"
          : state === "failed"
            ? "attention"
            : "current",
    },
    {
      n: 2,
      title: "Verify domain",
      hint: verified
        ? "Verified"
        : state === "failed"
          ? "Couldn't verify"
          : stale
            ? "Needs attention"
            : dns.requiredResolved
              ? "Finalizing…"
              : "Checking automatically",
      status: verified
        ? "complete"
        : state === "failed" || stale
          ? "attention"
          : dns.requiredResolved
            ? "current"
            : "upcoming",
    },
    ...(hasDeliverability
      ? [
          {
            n: 3 as const,
            title: "Improve deliverability",
            hint: domain.mailFromStatus === "success" ? "Return-Path active" : "Optional",
            status: (domain.mailFromStatus === "success" ? "complete" : "upcoming") as StepStatus,
          },
        ]
      : []),
  ];

  return (
    <div className="grid gap-8 pt-4 sm:pt-6 lg:grid-cols-[220px_minmax(0,1fr)]">
      <StepRail steps={steps} selected={selectedStep} onSelect={setSelectedStep} />

      <div className="min-w-0 space-y-8">
        {selectedStep === 1 && (
          <div className="space-y-8">
            <StepHeader
              n={1}
              total={totalSteps}
              title="Add your DNS records"
              description={
                <>
                  Add the records below wherever you manage{" "}
                  <span className="font-medium text-foreground">{root}</span>&apos;s DNS. We detect
                  them automatically — there&apos;s nothing to submit here.
                </>
              }
            />

            {!fullyConfigured && (
              <CloudflareAutoConfig domain={domain} onChange={onChange} onConfigured={check} />
            )}

            {domain.dnsWriteError && !verified && (
              <DnsWriteErrorNotice error={domain.dnsWriteError} />
            )}

            {verifyRecords.length === 0 ? (
              <RecordsNotReady checking={checking} onCheck={() => check({ manual: true })} />
            ) : (
              <ChecklistSection
                title="Records to add"
                subtitle={
                  <>
                    Each card is one record. Copy its{" "}
                    <span className="font-medium text-foreground">Type</span>,{" "}
                    <span className="font-medium text-foreground">Name</span>, and{" "}
                    <span className="font-medium text-foreground">Value</span> into the matching
                    fields at your host.
                  </>
                }
                records={verifyRecords}
                resolvedByKey={resolvedByKey}
                displayName={displayName}
              />
            )}
          </div>
        )}

        {selectedStep === 2 && (
          <div className="space-y-3">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Step 2 of {totalSteps}
            </p>
            <StatusHero
              domain={domain}
              state={state}
              stale={stale}
              checking={checking}
              lastChecked={lastChecked}
              dnsResolved={dns.requiredResolved}
              onCheck={() => check({ manual: true })}
            />
          </div>
        )}

        {selectedStep === 3 && hasDeliverability && (
          <div className="space-y-8">
            <StepHeader
              n={3}
              total={totalSteps}
              optional
              title="Improve deliverability"
              description="A custom Return-Path and DMARC strengthen SPF/DMARC alignment, so more of your mail lands in the inbox. Entirely optional — add these whenever you like."
            />
            <DeliverabilitySection
              returnPath={returnPathRecords}
              dmarc={dmarcRecords}
              resolvedByKey={resolvedByKey}
              displayName={displayName}
              mailFromStatus={domain.mailFromStatus}
            />
          </div>
        )}

        <HelpSection root={root} />
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------- */

type StepStatus = "complete" | "current" | "upcoming" | "attention";
type StepItem = { n: 1 | 2 | 3; title: string; hint: string; status: StepStatus };

// The left-hand guide rail: a vertical, clickable stepper. Each step's dot shows
// real progress (done / in progress / waiting / needs attention) while the ring
// shows which step is open — so reviewing a finished step never looks unfinished.
function StepRail({
  steps,
  selected,
  onSelect,
}: {
  steps: StepItem[];
  selected: 1 | 2 | 3;
  onSelect: (n: 1 | 2 | 3) => void;
}) {
  return (
    <nav aria-label="Domain setup steps" className="lg:sticky lg:top-6 lg:self-start">
      <ol>
        {steps.map((s, i) => {
          const isLast = i === steps.length - 1;
          const active = selected === s.n;
          return (
            <li key={s.n}>
              <button
                type="button"
                onClick={() => onSelect(s.n)}
                aria-current={active ? "step" : undefined}
                className="group flex w-full items-stretch gap-3 text-left"
              >
                <div className="flex flex-col items-center">
                  <StepDot status={s.status} n={s.n} active={active} />
                  {!isLast && <span className="mt-1 w-px flex-1 bg-border" />}
                </div>
                <div className={cn("pb-7", isLast && "pb-0")}>
                  <span
                    className={cn(
                      "block text-sm font-medium transition-colors",
                      active
                        ? "text-foreground"
                        : s.status === "upcoming"
                          ? "text-muted-foreground group-hover:text-foreground"
                          : "text-foreground/90 group-hover:text-foreground",
                    )}
                  >
                    {s.title}
                  </span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">{s.hint}</span>
                </div>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function StepDot({ status, n, active }: { status: StepStatus; n: number; active: boolean }) {
  return (
    <span
      className={cn(
        "relative flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold transition-colors",
        status === "complete" && "border-primary bg-primary text-primary-foreground",
        status === "current" && "border-primary bg-primary text-primary-foreground",
        status === "attention" && "border-amber-500/60 bg-background text-amber-500",
        status === "upcoming" && "border-border bg-background text-muted-foreground",
        active && "ring-2 ring-primary/40 ring-offset-2 ring-offset-background",
      )}
    >
      {status === "complete" ? (
        <Check className="size-3.5" />
      ) : status === "attention" ? (
        <AlertCircle className="size-3.5" />
      ) : (
        n
      )}
    </span>
  );
}

function StepHeader({
  n,
  total,
  title,
  description,
  optional,
}: {
  n: number;
  total: number;
  title: string;
  description?: ReactNode;
  optional?: boolean;
}) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        Step {n} of {total}
        {optional ? " · Optional" : ""}
      </p>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {description && <p className="text-sm text-muted-foreground">{description}</p>}
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
              {configuring ? <OrbitLoader size={16} /> : <Zap />}
              {done ? "Records added" : configuring ? "Configuring…" : "Configure automatically"}
            </Button>
          )}
          {(expired || !connection) && reconnectButton}
          {connection && (
            <Button variant="ghost" size="sm" onClick={disconnect} disabled={disconnecting}>
              {disconnecting ? <OrbitLoader size={16} /> : null}
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
      <div className="flex flex-col gap-4 rounded-xl border border-primary/20 bg-primary/5 p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <CheckCircle2 className="size-8 shrink-0 text-primary" />
          <div className="flex-1">
            <h2 className="font-medium">Your domain is verified 🎉</h2>
            <p className="text-sm text-muted-foreground">
              We&apos;ve set up{" "}
              <span className="font-medium text-foreground">
                {domain.fromName ? `${domain.fromName} ` : ""}
                &lt;{domain.fromEmail ?? domain.domain}&gt;
              </span>{" "}
              as your default sender — you can add more or change it any time under{" "}
              <Link href="/senders" className="underline underline-offset-4">
                Senders
              </Link>
              {domain.adminOverrideVerified && domain.verificationStatus !== "verified"
                ? " (verified by support)."
                : "."}
            </p>
          </div>
        </div>
        {/* Momentum: verifying a domain is a milestone, not an end. Point the user
            straight at the next steps instead of leaving them on this page. */}
        <div className="flex flex-col gap-2 border-t border-primary/15 pt-4 sm:flex-row">
          <Button render={<Link href="/audiences" />} className="sm:w-auto">
            Import your audience
            <ArrowRight className="size-4" />
          </Button>
          <Button variant="outline" render={<Link href="/campaigns/new" />} className="sm:w-auto">
            Create your first campaign
          </Button>
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
      <StatusCard
        tone="border-amber-500/40 bg-amber-500/5"
        indicator={<AlertCircle className="size-5 shrink-0 text-amber-500" />}
        title="This domain needs your attention"
        body="It's been pending for more than two weeks, so we've paused the automatic checks. If you've since added the DNS records below, run a re-check now and we'll pick verification back up. Otherwise, add the records and re-check."
        meta={lastChecked ? `Last checked ${ago(lastChecked)}` : null}
        action={
          <CheckButton checking={checking} onCheck={onCheck} label="Re-check now" variant="default" />
        }
      />
    );
  }

  const failed = state === "failed";
  // DKIM records are live in public DNS but SES hasn't flipped to verified yet —
  // the part we control is done, so say so instead of a generic "waiting".
  const confirmed = !failed && dnsResolved;

  const tone = failed
    ? "border-destructive/30 bg-destructive/5"
    : confirmed
      ? "border-primary/20 bg-primary/5"
      : "bg-muted/40";

  const indicator = failed ? (
    <AlertCircle className="size-5 shrink-0 text-destructive" />
  ) : confirmed ? (
    <CheckCircle2 className="size-5 shrink-0 text-primary" />
  ) : (
    <LiveDot />
  );

  const meta = failed
    ? lastChecked
      ? `Last checked ${ago(lastChecked)}`
      : null
    : `Checking automatically${lastChecked ? ` · last checked ${ago(lastChecked)}` : "…"}`;

  return (
    <StatusCard
      tone={tone}
      indicator={indicator}
      title={
        failed
          ? "We couldn't verify this domain yet"
          : confirmed
            ? "DNS records confirmed — finalizing"
            : "Waiting for your DNS records"
      }
      body={
        failed
          ? "The records below may be missing or mistyped. Fix them at your DNS host and we'll keep checking automatically."
          : confirmed
            ? "Your DKIM records are live. We're finalizing verification with your email provider — this usually takes a few minutes, and we're checking continuously."
            : "Add the DNS records below at your domain host. We check automatically every few minutes — most domains verify within an hour, though DNS can take up to 48 hours."
      }
      meta={meta}
      action={<CheckButton checking={checking} onCheck={onCheck} label="Check now" variant="outline" />}
    />
  );
}

/**
 * Status banner for a domain's verification state. Title sits on one baseline
 * with a small status indicator and the manual-check action; the explanation
 * and a single subtle meta line follow below. Keeping the indicator small and
 * inline (rather than a tall icon column) is what makes the row read as aligned.
 */
function StatusCard({
  tone,
  indicator,
  title,
  body,
  meta,
  action,
}: {
  tone: string;
  indicator: React.ReactNode;
  title: string;
  body: string;
  meta: string | null;
  action: React.ReactNode;
}) {
  return (
    <div className={cn("rounded-xl border p-5", tone)}>
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 items-center gap-2.5">
          {indicator}
          <h2 className="font-medium">{title}</h2>
        </div>
        {action}
      </div>
      <p className="mt-3 text-sm text-muted-foreground">{body}</p>
      {meta ? <p className="mt-3 text-xs text-muted-foreground">{meta}</p> : null}
    </div>
  );
}

/** Calm "we're actively watching" pulse — replaces the noisier bouncing mark. */
function LiveDot() {
  return (
    <span className="relative flex size-2.5 shrink-0" aria-hidden>
      <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
      <span className="relative inline-flex size-2.5 rounded-full bg-primary" />
    </span>
  );
}

/** The single manual re-check control. Its spinner is the only check feedback. */
function CheckButton({
  checking,
  onCheck,
  label,
  variant,
}: {
  checking: boolean;
  onCheck: () => void;
  label: string;
  variant: "default" | "outline";
}) {
  return (
    <Button
      variant={variant}
      size="sm"
      onClick={onCheck}
      disabled={checking}
      className="shrink-0"
    >
      {checking ? <OrbitLoader size={16} /> : <RefreshCw />}
      {checking ? "Checking…" : label}
    </Button>
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
        {checking ? <OrbitLoader size={16} /> : <RefreshCw />}
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
}: {
  title: string;
  subtitle?: ReactNode;
  records: DnsRecord[];
  resolvedByKey: Map<string, boolean>;
  displayName: (name: string) => string;
}) {
  const found = records.filter((r) => resolvedByKey.get(recordKey(r))).length;
  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="font-medium">{title}</h3>
          {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
        </div>
        <span className="shrink-0 text-xs text-muted-foreground">
          {found} of {records.length} found
        </span>
      </div>
      <div className="space-y-4">
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
  // Rendered expanded inside its own step — the stepper provides the disclosure,
  // so this just lays out the two optional groups: the custom Return-Path (MX +
  // SPF) with SES's live status, and the recommended DMARC record.
  return (
    <div className="space-y-6">
      {returnPath.length > 0 && (
        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Custom Return-Path</h3>
            <ReturnPathStatus status={mailFromStatus} />
          </div>
          {returnPath.map((r) => (
            <RecordRow
              key={recordKey(r)}
              record={r}
              displayName={displayName(r.name)}
              resolved={!!resolvedByKey.get(recordKey(r))}
            />
          ))}
        </section>
      )}

      {dmarc.length > 0 && (
        <section className="space-y-3">
          <div className="space-y-1">
            <h3 className="flex items-center gap-2 text-sm font-medium">
              DMARC
              <Badge variant="secondary">Recommended</Badge>
            </h3>
            <p className="text-xs text-muted-foreground">
              Improves inbox placement. Add it now or come back later.
            </p>
          </div>
          {dmarc.map((r) => (
            <RecordRow
              key={recordKey(r)}
              record={r}
              displayName={displayName(r.name)}
              resolved={!!resolvedByKey.get(recordKey(r))}
            />
          ))}
        </section>
      )}
    </div>
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
        <OrbitLoader size={14} />
      )}
      Return-Path {ok ? "active" : broken ? "needs attention" : "pending"}
    </span>
  );
}

// A single record laid out like the form the user fills in at their DNS host:
// the record's Type as a plain-language title, its live status on the right, and
// the Name and Value as big click-to-copy fields. MX rows surface their priority.
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
    <div className="rounded-xl border bg-card p-4 sm:p-5">
      <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-semibold">{record.type} record</span>
        {record.description && (
          <span className="text-sm text-muted-foreground">· {record.description}</span>
        )}
        {record.type === "MX" && record.priority != null && (
          <Badge variant="secondary">Priority {record.priority}</Badge>
        )}
        <span className="ml-auto">
          <StatusPill resolved={resolved} />
        </span>
      </div>
      <div className="space-y-3">
        <CopyField label="Name" value={displayName} />
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
        <OrbitLoader size={14} />
      )}
      {resolved ? "Found" : "Waiting"}
    </span>
  );
}

/* ----------------------------------------------------------------------------- */

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
    <div className="min-w-0 space-y-1.5">
      <div className="text-xs font-medium text-foreground">{label}</div>
      <button
        type="button"
        onClick={onCopy}
        title={`${value}\n\nClick to copy`}
        className="group/field flex w-full min-w-0 items-center gap-2 rounded-lg border bg-muted/40 py-2.5 pr-2.5 pl-3 text-left transition-colors hover:border-primary/40 hover:bg-muted"
      >
        <code className="min-w-0 flex-1 truncate font-mono text-sm">{value}</code>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
            copied
              ? "bg-primary/10 text-primary"
              : "bg-background text-muted-foreground group-hover/field:text-foreground",
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
              We show the name without{" "}
              <span className="font-medium text-foreground">{root}</span>, which nearly every host
              appends for you. If your host saves the name exactly as typed (a raw zone-file host),
              add <span className="font-medium text-foreground">.{root}</span> to the end of each
              Name yourself.
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
