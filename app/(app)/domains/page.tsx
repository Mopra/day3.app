"use client";

import { useCallback, useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
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
import { formatDate } from "@/lib/format";
import type { SendingDomain } from "@/lib/types";

type DomainForm = { domain: string; fromName: string; fromEmail: string };

export default function DomainsPage() {
  const api = useApi();
  const [domains, setDomains] = useState<SendingDomain[] | null>(null);
  const [open, setOpen] = useState(false);
  const { register, handleSubmit, reset, formState } = useForm<DomainForm>();

  const load = useCallback(() => {
    api
      .get<{ domains: SendingDomain[] }>("/api/domains")
      .then((res) => setDomains(res.domains))
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load]);

  const onSubmit = handleSubmit(async (values) => {
    try {
      await api.post("/api/domains", values);
      toast.success("Domain added. It needs verification before real sends.");
      setOpen(false);
      reset();
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add domain");
    }
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Sending domains</h1>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger render={<Button>Add domain</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Add sending domain</DialogTitle>
            </DialogHeader>
            <form onSubmit={onSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="domain">Domain</Label>
                <Input id="domain" placeholder="updates.yourcompany.com" {...register("domain", { required: true })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fromName">From name</Label>
                <Input id="fromName" placeholder="Your Company" {...register("fromName", { required: true })} />
              </div>
              <div className="space-y-2">
                <Label htmlFor="fromEmail">From email</Label>
                <Input id="fromEmail" placeholder="news@updates.yourcompany.com" {...register("fromEmail", { required: true })} />
              </div>
              <Button type="submit" disabled={formState.isSubmitting} className="w-full">
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
            <p className="py-6 text-center text-sm text-muted-foreground">
              Add the domain you will send newsletters from. Real campaigns require a verified
              domain (or an admin override while onboarding).
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Domain</TableHead>
                  <TableHead>From</TableHead>
                  <TableHead>Verification</TableHead>
                  <TableHead>Added</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {domains.map((d) => (
                  <TableRow key={d.id}>
                    <TableCell className="font-medium">{d.domain}</TableCell>
                    <TableCell className="text-muted-foreground">
                      {d.fromName} &lt;{d.fromEmail}&gt;
                    </TableCell>
                    <TableCell>
                      {d.adminOverrideVerified ? (
                        <Badge>verified (override)</Badge>
                      ) : (
                        <Badge variant={d.verificationStatus === "verified" ? "default" : "secondary"}>
                          {d.verificationStatus}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{formatDate(d.createdAt)}</TableCell>
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
