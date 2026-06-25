"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { AtSign, CheckCircle2, Pencil, Star, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  ListCount,
  ListEmpty,
  ListFilter,
  ListNoResults,
  ListSearch,
  ListSkeleton,
  ListToolbar,
  RowActions,
  SortableHead,
  useListController,
} from "@/components/ui/data-list";
import { MenuItem, MenuSeparator } from "@/components/ui/menu";
import { useApi } from "@/lib/api";
import { domainState } from "@/lib/domain";
import { formatDate } from "@/lib/format";
import type { Sender, SendingDomain } from "@/lib/types";

// A sender can send once its domain is SES-verified or admin-overridden.
function senderVerified(s: Sender): boolean {
  return !!s.adminOverrideVerified || s.verificationStatus === "verified";
}

const STATUS_OPTIONS = [
  { value: "all", label: "All senders" },
  { value: "verified", label: "Verified" },
  { value: "unverified", label: "Needs setup" },
];

export default function SendersPage() {
  const api = useApi();
  const [senders, setSenders] = useState<Sender[] | null>(null);
  const [domains, setDomains] = useState<SendingDomain[]>([]);
  const [status, setStatus] = useState("all");

  // Add/edit dialog. `editing` holds the sender being edited (null = add new).
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Sender | null>(null);
  const [domainId, setDomainId] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [emailEdited, setEmailEdited] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState<Sender | null>(null);
  const [removing, setRemoving] = useState(false);

  const verifiedDomains = domains.filter((d) => domainState(d) === "verified");

  const load = useCallback(() => {
    api
      .get<{ senders: Sender[] }>("/api/senders")
      .then((res) => setSenders(res.senders))
      .catch((err) => toast.error(err.message));
    api
      .get<{ domains: SendingDomain[] }>("/api/domains")
      .then((res) => setDomains(res.domains))
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(load, [load]);

  const list = useListController(senders, {
    searchText: (s) => `${s.fromName} ${s.fromEmail} ${s.domain ?? ""}`,
    predicate: (s) =>
      status === "all" || (status === "verified" ? senderVerified(s) : !senderVerified(s)),
    sortAccessors: {
      from: (s) => s.fromName,
      domain: (s) => s.domain,
      createdAt: (s) => s.createdAt,
    },
    initialSort: { key: "createdAt", dir: "desc" },
  });

  function openAdd() {
    setEditing(null);
    const only = verifiedDomains.length === 1 ? verifiedDomains[0] : undefined;
    setDomainId(only?.id ?? "");
    setName("");
    setEmail(only ? `news@${only.domain}` : "");
    setEmailEdited(false);
    setOpen(true);
  }

  function openEdit(s: Sender) {
    setEditing(s);
    setDomainId(s.sendingDomainId);
    setName(s.fromName);
    setEmail(s.fromEmail);
    setEmailEdited(true);
    setOpen(true);
  }

  // Suggest news@<domain> until the user edits the address.
  function onDomainChange(id: string) {
    setDomainId(id);
    if (!emailEdited) {
      const d = verifiedDomains.find((x) => x.id === id);
      setEmail(d ? `news@${d.domain}` : "");
    }
  }

  async function save() {
    const domain = domains.find((d) => d.id === domainId);
    if (!domain) {
      toast.error("Pick a verified domain");
      return;
    }
    const fromName = name.trim();
    const fromEmail = email.trim().toLowerCase();
    if (!fromName) {
      toast.error("Add a from name");
      return;
    }
    if (!fromEmail.endsWith(`@${domain.domain}`)) {
      toast.error(`From email must end in @${domain.domain}`);
      return;
    }
    setSaving(true);
    try {
      const body = { sendingDomainId: domain.id, fromName, fromEmail };
      if (editing) await api.patch(`/api/senders/${editing.id}`, body);
      else await api.post("/api/senders", body);
      toast.success(editing ? "Sender updated" : "Sender added");
      setOpen(false);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save sender");
    } finally {
      setSaving(false);
    }
  }

  async function makeDefault(s: Sender) {
    try {
      await api.patch(`/api/senders/${s.id}`, {
        sendingDomainId: s.sendingDomainId,
        fromName: s.fromName,
        fromEmail: s.fromEmail,
        replyTo: s.replyTo ?? "",
        isDefault: true,
      });
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't update sender");
    }
  }

  async function remove() {
    if (!confirmRemove) return;
    setRemoving(true);
    try {
      await api.del(`/api/senders/${confirmRemove.id}`);
      toast.success("Sender deleted");
      setConfirmRemove(null);
      load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't remove sender");
    } finally {
      setRemoving(false);
    }
  }

  const noVerifiedDomain = verifiedDomains.length === 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold tracking-tight">Senders</h1>
        <Button onClick={openAdd}>Add sender</Button>
      </div>

      <p className="max-w-2xl text-sm text-muted-foreground">
        A sender is the <span className="font-medium">From</span> name and address your
        campaigns go out as. Pick one in the campaign composer instead of typing it each
        time. Every sender must use a verified{" "}
        <Link href="/domains" className="underline underline-offset-2 hover:text-foreground">
          sending domain
        </Link>
        .
      </p>

      {senders && senders.length > 0 && (
        <ListToolbar>
          <ListSearch value={list.search} onChange={list.setSearch} placeholder="Search senders…" />
          <ListFilter
            value={status}
            onChange={setStatus}
            options={STATUS_OPTIONS}
            ariaLabel="Filter by verification"
          />
          <ListCount shown={list.shown} total={list.total} noun="sender" className="ml-auto" />
        </ListToolbar>
      )}

      <Card>
        <CardContent>
          {list.view === null ? (
            <ListSkeleton />
          ) : list.isEmpty ? (
            <ListEmpty
              icon={AtSign}
              title="Add your first sender"
              description={
                noVerifiedDomain
                  ? "First verify a sending domain — then you can add the From identities your campaigns send as."
                  : "This is the From name and address your campaigns send as. You can keep several per domain."
              }
              action={
                noVerifiedDomain ? (
                  <Button render={<Link href="/domains">Set up a domain</Link>} />
                ) : (
                  <Button onClick={openAdd}>Add sender</Button>
                )
              }
            />
          ) : list.isFilteredEmpty ? (
            <ListNoResults onClear={() => { list.setSearch(""); setStatus("all"); }} />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <SortableHead label="From" sortKey="from" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Domain" sortKey="domain" sort={list.sort} onSort={list.toggleSort} />
                  <SortableHead label="Added" sortKey="createdAt" sort={list.sort} onSort={list.toggleSort} />
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {list.view.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell className="font-medium">
                      <div className="flex items-center gap-2">
                        <span>
                          {s.fromName}{" "}
                          <span className="text-muted-foreground">&lt;{s.fromEmail}&gt;</span>
                        </span>
                        {s.isDefault && (
                          <Badge variant="secondary" className="gap-1">
                            <Star className="size-3" />
                            Default
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <span className="inline-flex items-center gap-2 text-sm">
                        <span className="text-muted-foreground">{s.domain}</span>
                        {senderVerified(s) ? (
                          <span className="inline-flex items-center gap-1 text-primary">
                            <CheckCircle2 className="size-3.5" />
                            Verified
                          </span>
                        ) : (
                          <Link
                            href="/domains"
                            className="text-xs text-destructive underline underline-offset-2"
                          >
                            Needs setup
                          </Link>
                        )}
                      </span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{formatDate(s.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1">
                        <RowActions>
                          {!s.isDefault && (
                            <MenuItem onClick={() => makeDefault(s)}>
                              <Star />
                              Make default
                            </MenuItem>
                          )}
                          <MenuItem onClick={() => openEdit(s)}>
                            <Pencil />
                            Edit
                          </MenuItem>
                          <MenuSeparator />
                          <MenuItem variant="destructive" onClick={() => setConfirmRemove(s)}>
                            <Trash2 />
                            Delete
                          </MenuItem>
                        </RowActions>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editing ? "Edit sender" : "Add a sender"}</DialogTitle>
            <DialogDescription>
              The From name and address your campaigns send as.
            </DialogDescription>
          </DialogHeader>
          {noVerifiedDomain && !editing ? (
            <div className="space-y-3 text-sm text-muted-foreground">
              <p>You&apos;ll need a verified sending domain before you can add a sender.</p>
              <Button render={<Link href="/domains">Set up a domain</Link>} />
            </div>
          ) : (
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="senderDomain">Domain</Label>
                <Select
                  items={Object.fromEntries(verifiedDomains.map((d) => [d.id, d.domain]))}
                  value={domainId || null}
                  onValueChange={(v) => v && onDomainChange(v)}
                >
                  <SelectTrigger id="senderDomain" aria-label="Domain" className="w-full">
                    <SelectValue placeholder="Pick a verified domain" />
                  </SelectTrigger>
                  <SelectContent>
                    {verifiedDomains.map((d) => (
                      <SelectItem key={d.id} value={d.id}>
                        {d.domain}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="senderName">From name</Label>
                <Input
                  id="senderName"
                  placeholder="Jane from Acme"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
                <p className="text-xs text-muted-foreground">
                  The sender name people see in their inbox.
                </p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="senderEmail">From email</Label>
                <Input
                  id="senderEmail"
                  placeholder="news@news.acme.com"
                  value={email}
                  onChange={(e) => {
                    setEmailEdited(true);
                    setEmail(e.target.value);
                  }}
                />
                <p className="text-xs text-muted-foreground">
                  {domainId
                    ? `Must be an address at @${domains.find((d) => d.id === domainId)?.domain}.`
                    : "Must be an address at your domain."}
                </p>
              </div>
              <div className="flex justify-end gap-2 pt-1">
                <Button variant="ghost" onClick={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={save} disabled={saving}>
                  {saving && <OrbitLoader size={16} />}
                  {editing ? "Save changes" : "Add sender"}
                </Button>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!confirmRemove}
        onOpenChange={(o) => !o && setConfirmRemove(null)}
        title="Delete this sender?"
        description={
          confirmRemove
            ? `${confirmRemove.fromName} <${confirmRemove.fromEmail}> will no longer be available to pick in the composer. Campaigns already sent are unaffected.`
            : undefined
        }
        confirmLabel="Delete sender"
        busy={removing}
        onConfirm={remove}
      />
    </div>
  );
}
