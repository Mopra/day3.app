"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Clock,
  Globe,
  Loader2,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useApi } from "@/lib/api";
import { domainState, recheckWindowExpired } from "@/lib/domain";
import { formatDate } from "@/lib/format";
import type { DomainState, SendingDomain } from "@/lib/types";

type DomainForm = { domain: string; fromName: string; fromEmail: string };

// Pull a bare hostname out of whatever the user pastes (URLs, trailing slashes…).
function cleanDomain(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/^www\./, "");
}

const STATUS_UI: Record<DomainState, { label: string; icon: typeof CheckCircle2; className: string }> = {
  verified: { label: "Verified", icon: CheckCircle2, className: "text-primary" },
  pending: { label: "Verifying…", icon: Clock, className: "text-muted-foreground" },
  failed: { label: "Action needed", icon: AlertCircle, className: "text-destructive" },
};

function StatusCell({ domain }: { domain: SendingDomain }) {
  const state = domainState(domain);
  // A pending domain past the cron's recheck window has gone stale — the list
  // must flag it as needing a manual re-check rather than an endless "Verifying…".
  const stale = recheckWindowExpired(domain);
  const ui = stale
    ? { label: "Needs attention", icon: AlertCircle, className: "text-amber-500" }
    : STATUS_UI[state];
  const Icon = ui.icon;
  // A verified domain whose optional Return-Path isn't live yet still works, but
  // there's a deliverability win available — hint at it, understated.
  const returnPathPending =
    state === "verified" && !!domain.mailFromStatus && domain.mailFromStatus !== "success";
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
      <span className={`inline-flex items-center gap-1.5 ${ui.className}`}>
        <Icon className="size-4" />
        {ui.label}
      </span>
      {returnPathPending && (
        <span className="text-xs text-muted-foreground">· Return-Path pending</span>
      )}
    </span>
  );
}

export default function DomainsPage() {
  const api = useApi();
  const router = useRouter();
  const [domains, setDomains] = useState<SendingDomain[] | null>(null);
  const [open, setOpen] = useState(false);
  const [autoEmail, setAutoEmail] = useState(true);
  const { register, handleSubmit, reset, watch, setValue, formState } = useForm<DomainForm>();

  const load = useCallback(() => {
    api
      .get<{ domains: SendingDomain[] }>("/api/domains")
      .then((res) => setDomains(res.domains))
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load]);

  // Suggest a sensible from-address (news@domain) until the user edits it.
  const domainValue = watch("domain");
  useEffect(() => {
    if (!autoEmail) return;
    const d = cleanDomain(domainValue ?? "");
    setValue("fromEmail", d ? `news@${d}` : "");
  }, [domainValue, autoEmail, setValue]);

  const fromEmailReg = register("fromEmail", { required: true });

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      reset();
      setAutoEmail(true);
    }
  }

  const onSubmit = handleSubmit(async (values) => {
    const domain = cleanDomain(values.domain);
    const fromEmail = values.fromEmail.trim().toLowerCase();
    if (!fromEmail.endsWith(`@${domain}`)) {
      toast.error(`From email must end in @${domain}`);
      return;
    }
    try {
      const res = await api.post<{ domain: SendingDomain }>("/api/domains", {
        domain,
        fromName: values.fromName.trim(),
        fromEmail,
      });
      toast.success("Domain added — let's verify it.");
      openChange(false);
      // Take the user straight to the setup guide; that's where the work is.
      if (res?.domain?.id) router.push(`/domains/${res.domain.id}`);
      else load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add domain");
    }
  });

  const previewDomain = cleanDomain(domainValue ?? "");

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Sending domains</h1>
        <Dialog open={open} onOpenChange={openChange}>
          <DialogTrigger render={<Button>Add domain</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add a sending domain</DialogTitle>
              <DialogDescription>
                Use a domain you own. We&apos;ll show you the DNS records to add next.
              </DialogDescription>
            </DialogHeader>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="domain">Domain</Label>
                <Input
                  id="domain"
                  placeholder="news.yourcompany.com"
                  autoFocus
                  {...register("domain", { required: true })}
                />
                <p className="text-xs text-muted-foreground">
                  A subdomain like <span className="font-medium">news.yourcompany.com</span> is
                  recommended — it keeps newsletter sending separate from your main email.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fromName">From name</Label>
                <Input id="fromName" placeholder="Your Company" {...register("fromName", { required: true })} />
                <p className="text-xs text-muted-foreground">The sender name people see in their inbox.</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fromEmail">From email</Label>
                <Input
                  id="fromEmail"
                  placeholder="news@news.yourcompany.com"
                  {...fromEmailReg}
                  onChange={(e) => {
                    setAutoEmail(false);
                    fromEmailReg.onChange(e);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {previewDomain
                    ? `Must be an address at @${previewDomain}.`
                    : "Must be an address at your domain."}
                </p>
              </div>
              <Button type="submit" disabled={formState.isSubmitting} className="w-full">
                {formState.isSubmitting && <Loader2 className="animate-spin" />}
                Add domain
              </Button>
            </form>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent>
          {domains === null ? (
            <Skeleton className="h-24 w-full" />
          ) : domains.length === 0 ? (
            <div className="flex flex-col items-center py-10 text-center">
              <div className="flex size-11 items-center justify-center rounded-full bg-muted">
                <Globe className="size-5 text-muted-foreground" />
              </div>
              <p className="mt-3 font-medium">Add your first sending domain</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                This is the domain your newsletters are sent from. After adding it, you&apos;ll add a
                few DNS records so inboxes trust your email — we guide you through it.
              </p>
              <Button className="mt-4" onClick={() => setOpen(true)}>
                Add domain
              </Button>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Added</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((d) => (
                  <TableRow
                    key={d.id}
                    onClick={() => router.push(`/domains/${d.id}`)}
                    className="cursor-pointer"
                  >
                    <TableCell className="font-medium">
                      <Link
                        href={`/domains/${d.id}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {d.domain}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.fromName} &lt;{d.fromEmail}&gt;
                    </TableCell>
                    <TableCell>
                      <StatusCell domain={d} />
                    </TableCell>
                    <TableCell>{formatDate(d.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <span className="inline-flex items-center gap-1 text-sm text-muted-foreground">
                        {domainState(d) !== "verified" && (
                          <span className="hidden sm:inline">Finish setup</span>
                        )}
                        <ChevronRight className="size-4" />
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
