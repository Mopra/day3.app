"use client";

import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { ApiError, useApi } from "@/lib/api";
import { PROVIDER_CATALOG, PROVIDER_IDS, type ProviderId } from "@/importers/catalog";
import { cn } from "@/lib/utils";

type Source = {
  id: string;
  name: string;
  subscribedCount: number | null;
  totalCount: number | null;
};

type Failure = { message: string; code?: string };

// Codes that mean "the API is not a way in for this key", where the CSV export is
// the honest next step rather than "try again".
const CSV_FALLBACK_CODES = new Set(["no_access", "bad_key", "not_found"]);

/**
 * "Import from another provider": paste an API key, pick the list, start. The
 * key goes to the server twice (to list sources, then to start the job) and is
 * never kept in the browser beyond this dialog's state.
 */
export function ProviderImportDialog({
  audienceId,
  open,
  onOpenChange,
  initialProvider = "beehiiv",
  onStarted,
  onUseCsv,
}: {
  audienceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  initialProvider?: ProviderId;
  onStarted: () => void;
  onUseCsv: () => void;
}) {
  const api = useApi();
  const [provider, setProvider] = useState<ProviderId>(initialProvider);
  const [apiKey, setApiKey] = useState("");
  const [sources, setSources] = useState<Source[] | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const meta = PROVIDER_CATALOG[provider];

  // Forget everything, the key above all, whenever the dialog closes.
  useEffect(() => {
    if (open) {
      setProvider(initialProvider);
      return;
    }
    setApiKey("");
    setSources(null);
    setSourceId(null);
    setFailure(null);
  }, [open, initialProvider]);

  function pickProvider(id: ProviderId) {
    setProvider(id);
    setSources(null);
    setSourceId(null);
    setFailure(null);
  }

  function fail(err: unknown) {
    if (err instanceof ApiError) setFailure({ message: err.message, code: err.code });
    else setFailure({ message: err instanceof Error ? err.message : "Something went wrong" });
  }

  async function connect(e: React.FormEvent) {
    e.preventDefault();
    if (!apiKey.trim()) return;
    setBusy(true);
    setFailure(null);
    try {
      const res = await api.post<{ sources: Source[] }>(`/api/import-providers/${provider}/sources`, {
        apiKey: apiKey.trim(),
      });
      setSources(res.sources);
      setSourceId(res.sources.length === 1 ? res.sources[0].id : null);
      if (res.sources.length === 0) {
        setFailure({ message: `This ${meta.label} key has no ${meta.sourceNoun}s to import.` });
      }
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  async function start() {
    if (!sourceId) return;
    setBusy(true);
    setFailure(null);
    try {
      await api.post(`/api/audiences/${audienceId}/import/provider`, {
        provider,
        apiKey: apiKey.trim(),
        sourceId,
      });
      toast.success(`Import from ${meta.label} started. Progress shows below.`);
      onOpenChange(false);
      onStarted();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  }

  const showCsvFallback = failure && (!failure.code || CSV_FALLBACK_CODES.has(failure.code));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Import from another provider</DialogTitle>
          <DialogDescription>
            Paste an API key and we bring your whole list over: subscribers, and the people who
            unsubscribed, so they stay unsubscribed. Bounced and unconfirmed addresses are skipped.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="Provider">
          {PROVIDER_IDS.map((id) => (
            <Button
              key={id}
              type="button"
              size="sm"
              variant={id === provider ? "default" : "outline"}
              role="radio"
              aria-checked={id === provider}
              onClick={() => pickProvider(id)}
            >
              {PROVIDER_CATALOG[id].label}
            </Button>
          ))}
        </div>

        <form onSubmit={connect} className="space-y-2">
          <Label htmlFor="provider-api-key">{meta.label} API key</Label>
          <div className="flex gap-2">
            <Input
              id="provider-api-key"
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder={meta.keyPlaceholder}
              value={apiKey}
              onChange={(e) => {
                setApiKey(e.target.value);
                setSources(null);
                setSourceId(null);
              }}
            />
            <Button type="submit" variant="outline" disabled={busy || !apiKey.trim()}>
              {busy && sources === null && <OrbitLoader size={16} />}
              Connect
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            {meta.keyHelp}{" "}
            <a
              href={meta.keyHelpUrl}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Open {meta.label}
            </a>
            . We use the key only for this import and delete it when the import ends.
          </p>
        </form>

        {sources && sources.length > 0 && (
          <div className="space-y-2">
            <Label>Choose the {meta.sourceNoun}</Label>
            <div className="space-y-1.5" role="radiogroup" aria-label={meta.sourceNoun}>
              {sources.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="radio"
                  aria-checked={s.id === sourceId}
                  onClick={() => setSourceId(s.id)}
                  className={cn(
                    "flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2 text-left text-sm transition-colors",
                    s.id === sourceId ? "border-primary bg-primary/5" : "hover:bg-muted",
                  )}
                >
                  <span className="truncate">{s.name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    {s.subscribedCount !== null
                      ? `${s.subscribedCount.toLocaleString()} subscribed`
                      : s.totalCount !== null
                        ? `${s.totalCount.toLocaleString()} contacts`
                        : null}
                  </span>
                </button>
              ))}
            </div>
            <Button className="w-full" disabled={busy || !sourceId} onClick={start}>
              {busy && <OrbitLoader size={16} />}
              Start import
            </Button>
          </div>
        )}

        {failure && (
          <Alert variant="destructive">
            <AlertTitle>{meta.label} import could not start</AlertTitle>
            <AlertDescription>
              <p>{failure.message}</p>
            </AlertDescription>
          </Alert>
        )}

        {showCsvFallback && (
          <div className="space-y-2 rounded-md border p-3 text-sm">
            <p className="font-medium">Use a CSV export instead</p>
            <ol className="list-decimal space-y-1 pl-5 text-muted-foreground">
              {meta.exportSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ol>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                onOpenChange(false);
                onUseCsv();
              }}
            >
              Import CSV
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
