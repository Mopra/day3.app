"use client";

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { useApi, ApiError } from "@/lib/api";

// The webhooks surface on /api-keys. Endpoints are the inverse of API keys: a
// key lets your code reach into Day3, an endpoint lets Day3 reach out to your
// code. They live on the same page because they are the same job — connecting
// an app — and because someone here already has their deploy config open.

const EVENT_GROUPS: Array<{ label: string; hint: string; events: Array<{ id: string; label: string; hint: string }> }> = [
  {
    label: "Delivery",
    hint: "What happened to each message after you sent it.",
    events: [
      { id: "email.sent", label: "Sent", hint: "We handed the message to the mail provider." },
      { id: "email.delivered", label: "Delivered", hint: "The receiving server accepted it." },
      {
        id: "email.bounced",
        label: "Bounced",
        hint: "It came back. `bounce_type` tells you whether it's permanent.",
      },
      { id: "email.complained", label: "Marked as spam", hint: "The recipient reported it." },
      { id: "email.failed", label: "Failed", hint: "It never left — bad address, or blocked before sending." },
    ],
  },
  {
    label: "Suppression",
    hint: "Addresses Day3 will refuse to email again.",
    events: [
      {
        id: "suppression.created",
        label: "Address suppressed",
        hint: "A bounce, spam report, unsubscribe, or manual block. Mirror these into your own database.",
      },
    ],
  },
];

const ALL_EVENT_IDS = EVENT_GROUPS.flatMap((g) => g.events.map((e) => e.id));

type EndpointRow = {
  id: string;
  url: string;
  description: string | null;
  events: string[];
  status: "enabled" | "disabled";
  consecutiveFailures: number;
  lastSuccessAt: string | null;
  lastFailureAt: string | null;
  lastError: string | null;
  createdAt: string;
};

type DeliveryRow = {
  id: string;
  endpointId: string;
  eventId: string;
  eventType: string;
  status: "pending" | "delivering" | "succeeded" | "failed";
  attempt: number;
  responseStatus: number | null;
  error: string | null;
  durationMs: number | null;
  createdAt: string;
  payload: string;
};

function formatWhen(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function WebhooksSection() {
  const api = useApi();
  const [endpoints, setEndpoints] = useState<EndpointRow[] | null>(null);
  const [adminOnly, setAdminOnly] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<EndpointRow | null>(null);
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [selected, setSelected] = useState<string[]>(ALL_EVENT_IDS);
  const [saving, setSaving] = useState(false);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<EndpointRow | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [logOpen, setLogOpen] = useState<EndpointRow | null>(null);

  const reload = useCallback(
    () =>
      api
        .get<{ endpoints: EndpointRow[] }>("/api/webhook-endpoints")
        .then((res) => setEndpoints(res.endpoints))
        .catch((err) => {
          if (err instanceof ApiError && err.status === 403) setAdminOnly(true);
          else toast.error(err instanceof Error ? err.message : "Failed to load webhooks");
        }),
    [api],
  );

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const openCreate = () => {
    setEditing(null);
    setUrl("");
    setDescription("");
    setSelected(ALL_EVENT_IDS);
    setFreshSecret(null);
    setCreateOpen(true);
  };

  const openEdit = (e: EndpointRow) => {
    setEditing(e);
    setUrl(e.url);
    setDescription(e.description ?? "");
    setSelected(e.events);
    setFreshSecret(null);
    setCreateOpen(true);
  };

  const closeDialog = () => {
    setCreateOpen(false);
    setEditing(null);
    setFreshSecret(null);
  };

  const save = async () => {
    setSaving(true);
    try {
      if (editing) {
        await api.patch(`/api/webhook-endpoints/${editing.id}`, {
          url: url.trim(),
          description: description.trim() || null,
          events: selected,
        });
        toast.success("Endpoint updated");
        closeDialog();
      } else {
        const res = await api.post<{ secret: string }>("/api/webhook-endpoints", {
          url: url.trim(),
          description: description.trim() || undefined,
          events: selected,
        });
        setFreshSecret(res.secret);
      }
      void reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save endpoint");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-medium">Webhooks</h2>
          <p className="text-sm text-muted-foreground">
            Day3 POSTs an event to your server when a message is delivered, bounces, or an address
            gets suppressed — so your app can keep its own records in step without polling.
          </p>
        </div>
        {!adminOnly && (
          <Button onClick={openCreate} disabled={endpoints === null}>
            Add endpoint
          </Button>
        )}
      </div>

      {adminOnly ? (
        <p className="text-sm text-muted-foreground">
          Only organization admins can manage webhooks.
        </p>
      ) : endpoints === null ? (
        <OrbitLoader size={20} />
      ) : endpoints.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            No endpoints yet. Add one to receive delivery and suppression events.
          </p>
        </div>
      ) : (
        <div className="divide-y rounded-md border">
          {endpoints.map((e) => (
            <div key={e.id} className="flex items-start justify-between gap-4 px-4 py-3">
              <div className="min-w-0 space-y-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-mono text-sm">{e.url}</span>
                  {e.status === "disabled" && (
                    <Badge variant="outline" className="text-xs">
                      Paused
                    </Badge>
                  )}
                  {e.status === "enabled" && e.consecutiveFailures > 0 && (
                    <Badge variant="destructive" className="text-xs">
                      {e.consecutiveFailures} failing
                    </Badge>
                  )}
                </div>
                {e.description && (
                  <p className="truncate text-xs text-muted-foreground">{e.description}</p>
                )}
                <p className="text-xs text-muted-foreground">
                  {e.events.length} event{e.events.length === 1 ? "" : "s"} · Last delivered{" "}
                  {formatWhen(e.lastSuccessAt)}
                </p>
                {e.lastError && e.consecutiveFailures > 0 && (
                  <p className="truncate text-xs text-destructive">{e.lastError}</p>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="ghost" size="sm" onClick={() => setLogOpen(e)}>
                  Log
                </Button>
                <Button variant="outline" size="sm" onClick={() => openEdit(e)}>
                  Edit
                </Button>
                <Button variant="outline" size="sm" onClick={() => setDeleteTarget(e)}>
                  Delete
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={(open) => !open && closeDialog()}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          {freshSecret ? (
            <>
              <DialogHeader>
                <DialogTitle>Copy your signing secret</DialogTitle>
                <DialogDescription>
                  Every request carries a <code className="font-mono">Day3-Signature</code> header.
                  Verify it with this secret so you can trust the events are really from us. You can
                  view it again later.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <Input readOnly value={freshSecret} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(freshSecret);
                    toast.success("Copied");
                  }}
                >
                  Copy
                </Button>
              </div>
              <DialogFooter>
                <Button onClick={closeDialog}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>{editing ? "Edit endpoint" : "Add endpoint"}</DialogTitle>
                <DialogDescription>
                  We POST JSON here and expect any 2xx response. Answer fast and do the work
                  afterwards — we retry for about seven hours, then stop.
                </DialogDescription>
              </DialogHeader>

              <div className="space-y-2">
                <Label htmlFor="webhook-url">Endpoint URL</Label>
                <Input
                  id="webhook-url"
                  placeholder="https://yourapp.com/webhooks/day3"
                  value={url}
                  onChange={(ev) => setUrl(ev.target.value)}
                  className="font-mono text-xs"
                />
                <p className="text-xs text-muted-foreground">
                  Must be https and reachable from the internet.
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="webhook-description">Label (optional)</Label>
                <Input
                  id="webhook-description"
                  placeholder="Production API"
                  value={description}
                  onChange={(ev) => setDescription(ev.target.value)}
                  maxLength={200}
                />
              </div>

              <div className="space-y-3">
                <Label>Events</Label>
                {EVENT_GROUPS.map((group) => (
                  <div key={group.label} className="space-y-1.5">
                    <p className="text-xs font-medium text-muted-foreground">{group.hint}</p>
                    {group.events.map((ev) => (
                      <label
                        key={ev.id}
                        className="flex cursor-pointer items-start gap-2 rounded-md border px-3 py-2 text-sm"
                      >
                        <input
                          type="checkbox"
                          className="mt-0.5 size-4 accent-primary"
                          checked={selected.includes(ev.id)}
                          onChange={(e) =>
                            setSelected((prev) =>
                              e.target.checked ? [...prev, ev.id] : prev.filter((x) => x !== ev.id),
                            )
                          }
                        />
                        <span>
                          <span className="font-medium">{ev.label}</span>
                          <span className="ml-2 font-mono text-xs text-muted-foreground">
                            {ev.id}
                          </span>
                          <span className="block text-muted-foreground">{ev.hint}</span>
                        </span>
                      </label>
                    ))}
                  </div>
                ))}
              </div>

              <DialogFooter className="flex-wrap gap-2">
                {editing && (
                  <RotateSecretButton endpointId={editing.id} />
                )}
                <Button variant="outline" onClick={closeDialog}>
                  Cancel
                </Button>
                <Button disabled={saving || !url.trim() || selected.length === 0} onClick={save}>
                  {saving && <OrbitLoader size={16} />}
                  {editing ? "Save" : "Add endpoint"}
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      {logOpen && <DeliveryLogDialog endpoint={logOpen} onClose={() => setLogOpen(null)} />}

      <ConfirmDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        title="Delete this endpoint?"
        description="We'll stop sending events to it and its delivery history goes too. This cannot be undone."
        confirmLabel="Delete"
        busy={deleting}
        onConfirm={async () => {
          if (!deleteTarget) return;
          setDeleting(true);
          try {
            await api.del(`/api/webhook-endpoints/${deleteTarget.id}`);
            toast.success("Endpoint deleted");
            setDeleteTarget(null);
            void reload();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to delete endpoint");
          } finally {
            setDeleting(false);
          }
        }}
      />
    </section>
  );
}

// Reveal-or-rotate, in one control. Revealing is the common case (someone is
// re-deploying and needs the value); rotating is behind a confirm because it
// breaks verification at the receiver until the new secret is deployed.
function RotateSecretButton({ endpointId }: { endpointId: string }) {
  const api = useApi();
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmRotate, setConfirmRotate] = useState(false);

  if (secret) {
    return (
      <div className="mr-auto flex w-full items-center gap-2 sm:w-auto">
        <Input readOnly value={secret} className="font-mono text-xs" />
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            await navigator.clipboard.writeText(secret);
            toast.success("Copied");
          }}
        >
          Copy
        </Button>
      </div>
    );
  }

  return (
    <>
      <div className="mr-auto flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              const res = await api.get<{ secret: string }>(
                `/api/webhook-endpoints/${endpointId}/secret`,
              );
              setSecret(res.secret);
            } catch (err) {
              toast.error(err instanceof Error ? err.message : "Failed to read secret");
            } finally {
              setBusy(false);
            }
          }}
        >
          Show signing secret
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirmRotate(true)}>
          Rotate
        </Button>
      </div>
      <ConfirmDialog
        open={confirmRotate}
        onOpenChange={setConfirmRotate}
        title="Rotate the signing secret?"
        description="The current secret stops working immediately. Deploy code that accepts either secret first, then rotate, then drop the old one."
        confirmLabel="Rotate"
        busy={busy}
        onConfirm={async () => {
          setBusy(true);
          try {
            const res = await api.post<{ secret: string }>(
              `/api/webhook-endpoints/${endpointId}/secret`,
              {},
            );
            setSecret(res.secret);
            setConfirmRotate(false);
            toast.success("New secret generated");
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to rotate secret");
          } finally {
            setBusy(false);
          }
        }}
      />
    </>
  );
}

const LOG_PAGE = 25;

// Server-paginated delivery log — the debugging surface. Deliberately client-fetched
// (the documented exception): it opens on demand and pages through offsets.
function DeliveryLogDialog({ endpoint, onClose }: { endpoint: EndpointRow; onClose: () => void }) {
  const api = useApi();
  const [rows, setRows] = useState<DeliveryRow[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [offset, setOffset] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(
    async (next: number) => {
      try {
        const res = await api.get<{ deliveries: DeliveryRow[]; hasMore: boolean }>(
          `/api/webhook-deliveries?endpointId=${endpoint.id}&limit=${LOG_PAGE}&offset=${next}`,
        );
        setRows(res.deliveries);
        setHasMore(res.hasMore);
        setOffset(next);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load deliveries");
      }
    },
    [api, endpoint.id],
  );

  useEffect(() => {
    void load(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Deliveries</DialogTitle>
          <DialogDescription className="font-mono text-xs">{endpoint.url}</DialogDescription>
        </DialogHeader>

        {rows === null ? (
          <OrbitLoader size={20} />
        ) : rows.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">
            Nothing delivered yet. Events show up here as they happen.
          </p>
        ) : (
          <div className="divide-y rounded-md border text-sm">
            {rows.map((d) => (
              <div key={d.id} className="px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    onClick={() => setExpanded(expanded === d.id ? null : d.id)}
                  >
                    <Badge
                      variant={
                        d.status === "succeeded"
                          ? "secondary"
                          : d.status === "failed"
                            ? "destructive"
                            : "outline"
                      }
                      className="shrink-0 text-xs"
                    >
                      {d.responseStatus ?? d.status}
                    </Badge>
                    <span className="truncate font-mono text-xs">{d.eventType}</span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {formatWhen(d.createdAt)}
                      {d.attempt > 1 && ` · try ${d.attempt}`}
                      {d.durationMs !== null && ` · ${d.durationMs}ms`}
                    </span>
                  </button>
                  {(d.status === "failed" || d.status === "succeeded") && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={async () => {
                        try {
                          await api.post(`/api/webhook-deliveries/${d.id}/resend`, {});
                          toast.success("Queued for resend");
                          void load(offset);
                        } catch (err) {
                          toast.error(err instanceof Error ? err.message : "Failed to resend");
                        }
                      }}
                    >
                      Resend
                    </Button>
                  )}
                </div>
                {d.error && <p className="mt-1 text-xs text-destructive">{d.error}</p>}
                {expanded === d.id && (
                  <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-muted p-3 text-xs">
                    {JSON.stringify(JSON.parse(d.payload), null, 2)}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}

        <DialogFooter className="justify-between">
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={offset === 0}
              onClick={() => void load(Math.max(0, offset - LOG_PAGE))}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!hasMore}
              onClick={() => void load(offset + LOG_PAGE)}
            >
              Next
            </Button>
          </div>
          <Button onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
