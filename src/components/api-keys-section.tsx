"use client";

import { useEffect, useState } from "react";
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

type ApiKeyRow = {
  id: string;
  name: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  createdAt: string;
};

function formatDate(iso: string | null): string {
  if (!iso) return "never";
  return new Date(iso).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

// The key list on /api-keys: mint and revoke bearer keys for the public API
// (/api/v1). The full key is shown exactly once at creation — only its hash is
// stored server-side. Org-admin only (the API returns 403 for members).
//
// `onKeyCreated` hands the fresh key up to the page so the quickstart below can
// prefill its `export DAY3_API_KEY=…` line while it is still in memory. It is
// never persisted anywhere and is gone on reload.
export function ApiKeysSection({ onKeyCreated }: { onKeyCreated?: (key: string) => void } = {}) {
  const api = useApi();
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [adminOnly, setAdminOnly] = useState(false);

  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  // The one-time reveal: set right after create, cleared when dismissed.
  const [freshKey, setFreshKey] = useState<string | null>(null);

  const [revokeTarget, setRevokeTarget] = useState<ApiKeyRow | null>(null);
  const [revoking, setRevoking] = useState(false);

  const reload = () =>
    api
      .get<{ keys: ApiKeyRow[] }>("/api/api-keys")
      .then((res) => setKeys(res.keys))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 403) setAdminOnly(true);
        else toast.error(err instanceof Error ? err.message : "Failed to load API keys");
      });

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeKeys = keys?.filter((k) => !k.revokedAt) ?? [];

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-medium">Your keys</h2>
          <p className="text-sm text-muted-foreground">
            A key carries full access to this organization&apos;s audiences. Give each place that
            uses one its own key, so you can revoke it without breaking the others.
          </p>
        </div>
        {!adminOnly && (
          <Button onClick={() => setCreateOpen(true)} disabled={keys === null}>
            Create key
          </Button>
        )}
      </div>

      {adminOnly ? (
        <p className="text-sm text-muted-foreground">
          Only organization admins can manage API keys.
        </p>
      ) : keys === null ? (
        <OrbitLoader size={20} />
      ) : activeKeys.length === 0 ? (
        <div className="rounded-md border border-dashed px-4 py-6 text-center">
          <p className="text-sm text-muted-foreground">
            No keys yet. Create one to start using the API — it takes a few seconds.
          </p>
        </div>
      ) : (
        <div className="divide-y rounded-md border">
          {activeKeys.map((k) => (
            <div key={k.id} className="flex items-center justify-between gap-4 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{k.name}</span>
                  <Badge variant="outline" className="font-mono text-xs">
                    {k.keyPrefix}…
                  </Badge>
                </div>
                <p className="text-xs text-muted-foreground">
                  Created {formatDate(k.createdAt)} · Last used {formatDate(k.lastUsedAt)}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setRevokeTarget(k)}>
                Revoke
              </Button>
            </div>
          ))}
        </div>
      )}

      {/* Create dialog — swaps to the one-time key reveal after minting. */}
      <Dialog
        open={createOpen}
        onOpenChange={(open) => {
          if (!open) {
            setCreateOpen(false);
            setFreshKey(null);
            setName("");
          }
        }}
      >
        <DialogContent>
          {freshKey ? (
            <>
              <DialogHeader>
                <DialogTitle>Copy your API key</DialogTitle>
                <DialogDescription>
                  This is the only time the full key is shown. Store it somewhere safe — if you
                  lose it, revoke it and create a new one.
                </DialogDescription>
              </DialogHeader>
              <div className="flex items-center gap-2">
                <Input readOnly value={freshKey} className="font-mono text-xs" />
                <Button
                  variant="outline"
                  onClick={async () => {
                    await navigator.clipboard.writeText(freshKey);
                    toast.success("Copied");
                  }}
                >
                  Copy
                </Button>
              </div>
              <DialogFooter>
                <Button
                  onClick={() => {
                    setCreateOpen(false);
                    setFreshKey(null);
                    setName("");
                  }}
                >
                  Done
                </Button>
              </DialogFooter>
            </>
          ) : (
            <>
              <DialogHeader>
                <DialogTitle>Create API key</DialogTitle>
                <DialogDescription>
                  Name it after where it will live (“Production”, “Migration script”).
                </DialogDescription>
              </DialogHeader>
              <div className="space-y-2">
                <Label htmlFor="api-key-name">Name</Label>
                <Input
                  id="api-key-name"
                  placeholder="Production"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  maxLength={60}
                />
              </div>
              <DialogFooter>
                <Button variant="outline" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>
                <Button
                  disabled={creating || !name.trim()}
                  onClick={async () => {
                    setCreating(true);
                    try {
                      const res = await api.post<{ key: string }>("/api/api-keys", {
                        name: name.trim(),
                      });
                      setFreshKey(res.key);
                      onKeyCreated?.(res.key);
                      void reload();
                    } catch (err) {
                      toast.error(err instanceof Error ? err.message : "Failed to create key");
                    } finally {
                      setCreating(false);
                    }
                  }}
                >
                  {creating && <OrbitLoader size={16} />}
                  Create
                </Button>
              </DialogFooter>
            </>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
        title={`Revoke “${revokeTarget?.name}”?`}
        description="Requests using this key will start failing immediately. This cannot be undone."
        confirmLabel="Revoke"
        busy={revoking}
        onConfirm={async () => {
          if (!revokeTarget) return;
          setRevoking(true);
          try {
            await api.del(`/api/api-keys/${revokeTarget.id}`);
            toast.success("Key revoked");
            setRevokeTarget(null);
            void reload();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to revoke key");
          } finally {
            setRevoking(false);
          }
        }}
      />
    </section>
  );
}
