"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { RowActions } from "@/components/ui/data-list";
import { MenuItem } from "@/components/ui/menu";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiPanel } from "@/components/api-panel";
import { DomainSetupGuide } from "@/components/domain-setup-guide";
import { ApiError, useApi } from "@/lib/api";
import { buildDomainsPanelContent } from "@/lib/api-docs";
import { domainState } from "@/lib/domain";
import type { SendingDomain } from "@/lib/types";

const STATUS_LABEL: Record<string, string> = {
  verified: "Verified",
  pending: "Verifying…",
  failed: "Action needed",
};

export default function DomainDetailPage() {
  const { id } = useParams<{ id: string }>();
  const api = useApi();
  const router = useRouter();
  const [domain, setDomain] = useState<SendingDomain | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [removing, setRemoving] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ domain: SendingDomain }>(`/api/domains/${id}`)
      .then((res) => setDomain(res.domain))
      .catch((err) => {
        if (err instanceof ApiError && err.status === 404) setNotFound(true);
        else toast.error(err instanceof Error ? err.message : "Failed to load domain");
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  useEffect(load, [load]);

  async function remove() {
    setRemoving(true);
    try {
      await api.del(`/api/domains/${id}`);
      toast.success("Domain deleted");
      router.push("/domains");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't delete domain");
      setRemoving(false);
    }
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <Link
        href="/domains"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-4" />
        Sending domains
      </Link>

      {notFound ? (
        <div className="rounded-xl border border-dashed p-10 text-center">
          <p className="font-medium">Domain not found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            It may have been removed. Go back to your sending domains.
          </p>
          <Button className="mt-4" render={<Link href="/domains">Back to domains</Link>} />
        </div>
      ) : domain === null ? (
        <div className="space-y-4">
          <Skeleton className="h-9 w-64" />
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <h1 className="font-display text-3xl">{domain.domain}</h1>
                <Badge
                  className="translate-y-[3px]"
                  variant={domainState(domain) === "verified" ? "default" : "secondary"}
                >
                  {STATUS_LABEL[domainState(domain)]}
                </Badge>
                <ApiPanel
                  build={(origin) =>
                    buildDomainsPanelContent({
                      origin,
                      domains: [{ id: domain.id, domain: domain.domain }],
                    })
                  }
                />
              </div>
              <p className="text-sm text-muted-foreground">
                Sending as {domain.fromName} &lt;{domain.fromEmail}&gt;
              </p>
            </div>

            <RowActions>
              <MenuItem variant="destructive" onClick={() => setDeleteOpen(true)}>
                <Trash2 />
                Delete
              </MenuItem>
            </RowActions>
          </div>

          <DomainSetupGuide domain={domain} onChange={setDomain} />

          <ConfirmDialog
            open={deleteOpen}
            onOpenChange={setDeleteOpen}
            title={`Delete "${domain.domain}"?`}
            description="This removes the domain and its senders from Day3. Campaigns already sent are unaffected. You can add it again later, but you'll need to re-verify it (and re-add its DNS records) to send from it again."
            confirmLabel="Delete domain"
            busy={removing}
            onConfirm={remove}
          />
        </>
      )}
    </div>
  );
}
