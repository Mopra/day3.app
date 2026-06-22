"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight, FileInput } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
import { OrbitLoader } from "@/components/ui/orbit-loader";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import type { Audience, SignupForm } from "@/lib/types";

export default function FormsPage() {
  const api = useApi();
  const router = useRouter();
  const [forms, setForms] = useState<SignupForm[] | null>(null);
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [name, setName] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const [doubleOptIn, setDoubleOptIn] = useState(true);
  const [collectName, setCollectName] = useState(false);

  const load = useCallback(() => {
    api
      .get<{ forms: SignupForm[] }>("/api/forms")
      .then((res) => setForms(res.forms))
      .catch((err) => toast.error(err.message));
    api
      .get<{ audiences: Audience[] }>("/api/audiences")
      .then((res) => setAudiences(res.audiences))
      .catch(() => setAudiences([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load]);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setName("");
      setAudienceId("");
      setDoubleOptIn(true);
      setCollectName(false);
    }
  }

  async function create() {
    if (!name.trim()) return toast.error("Give your form a name");
    if (!audienceId) return toast.error("Choose an audience");
    setSubmitting(true);
    try {
      const res = await api.post<{ form: { id: string } }>("/api/forms", {
        name: name.trim(),
        audienceId,
        doubleOptIn,
        collectName,
      });
      toast.success("Form created");
      openChange(false);
      router.push(`/forms/${res.form.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to create form");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Signup forms</h1>
        <Dialog open={open} onOpenChange={openChange}>
          <DialogTrigger render={<Button disabled={audiences.length === 0}>New form</Button>} />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Create a signup form</DialogTitle>
              <DialogDescription>
                Collect newsletter signups from your website, a shared link, or an embed. You can
                fine-tune the design and copy next.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="name">Form name</Label>
                <Input
                  id="name"
                  placeholder="Website newsletter"
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">Just for you — subscribers won&apos;t see it.</p>
              </div>
              <div className="space-y-1.5">
                <Label>Audience</Label>
                <Select items={audiences.map((a) => ({ value: a.id, label: a.name }))} value={audienceId} onValueChange={(v) => setAudienceId(v as string)}>
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Choose an audience" />
                  </SelectTrigger>
                  <SelectContent>
                    {audiences.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">Signups land in this audience.</p>
              </div>
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={doubleOptIn}
                  onChange={(e) => setDoubleOptIn(e.target.checked)}
                />
                <span>
                  <span className="font-medium">Require email confirmation</span>
                  <span className="block text-xs text-muted-foreground">
                    Recommended. New signups confirm via email before they can be sent campaigns —
                    protects your sender reputation from bots and typos.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  className="mt-0.5 size-4 accent-primary"
                  checked={collectName}
                  onChange={(e) => setCollectName(e.target.checked)}
                />
                <span>
                  <span className="font-medium">Also ask for first name</span>
                  <span className="block text-xs text-muted-foreground">
                    Lets you personalize campaigns with a merge tag.
                  </span>
                </span>
              </label>
              <Button onClick={create} disabled={submitting} className="w-full">
                {submitting && <OrbitLoader size={16} />}
                Create form
              </Button>
            </div>
          </DialogContent>
        </Dialog>
      </div>

      <Card>
        <CardContent>
          {forms === null ? (
            <Skeleton className="h-24 w-full" />
          ) : forms.length === 0 ? (
            <div className="flex flex-col items-center py-10 text-center">
              <div className="flex size-11 items-center justify-center rounded-full bg-muted">
                <FileInput className="size-5 text-muted-foreground" />
              </div>
              <p className="mt-3 font-medium">Create your first signup form</p>
              <p className="mt-1 max-w-sm text-sm text-muted-foreground">
                {audiences.length === 0
                  ? "First create an audience — signups need somewhere to land."
                  : "Share a link, embed it on your site, or drop in raw HTML. Signups flow straight into your audience."}
              </p>
              {audiences.length === 0 ? (
                <Button className="mt-4" render={<Link href="/audiences" />}>
                  Create an audience
                </Button>
              ) : (
                <Button className="mt-4" onClick={() => setOpen(true)}>
                  New form
                </Button>
              )}
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Audience</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Signups</TableHead>
                  <TableHead className="text-right">Confirmed</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {forms.map((f) => (
                  <TableRow
                    key={f.id}
                    onClick={() => router.push(`/forms/${f.id}`)}
                    className="cursor-pointer"
                  >
                    <TableCell className="font-medium">
                      <Link
                        href={`/forms/${f.id}`}
                        className="hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {f.name}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{f.audienceName ?? "—"}</TableCell>
                    <TableCell>
                      <Badge variant={f.status === "active" ? "default" : "secondary"}>
                        {f.status === "active" ? "Active" : "Off"}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{f.submitCount}</TableCell>
                    <TableCell className="text-right tabular-nums">{f.confirmedCount}</TableCell>
                    <TableCell>{formatDate(f.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <ChevronRight className="size-4 text-muted-foreground" />
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
