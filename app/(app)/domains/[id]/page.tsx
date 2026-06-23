"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { DomainSetupGuide } from "@/components/domain-setup-guide";
import { ApiError, useApi } from "@/lib/api";
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
      toast.success("Domain removed");
      router.push("/domains");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to remove domain");
      setRemoving(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
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
                <h1 className="text-2xl font-semibold tracking-tight">{domain.domain}</h1>
                <Badge variant={domainState(domain) === "verified" ? "default" : "secondary"}>
                  {STATUS_LABEL[domainState(domain)]}
                </Badge>
              </div>
              <p className="text-sm text-muted-foreground">
                Sending as {domain.fromName} &lt;{domain.fromEmail}&gt;
              </p>
            </div>

            <Dialog>
              <DialogTrigger
                render={
                  <Button variant="ghost" size="sm">
                    <Trash2 />
                    Remove
                  </Button>
                }
              />
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Remove {domain.domain}?</DialogTitle>
                  <DialogDescription>
                    You can add it again later, but you&apos;ll need to verify it from scratch.
                    Campaigns currently using this domain will be blocked from sending.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose render={<Button variant="outline">Cancel</Button>} />
                  <Button variant="destructive" onClick={remove} disabled={removing}>
                    {removing ? <OrbitLoader size={16} /> : <Trash2 />}
                    Remove domain
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>

          <DomainSetupGuide domain={domain} onChange={setDomain} />
        </>
      )}
    </div>
  );
}
