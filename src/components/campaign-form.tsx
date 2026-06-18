"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Controller, useForm } from "react-hook-form";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useApi } from "@/lib/api";
import { domainState } from "@/lib/domain";
import type { Audience, Campaign, SendingDomain } from "@/lib/types";

export type CampaignFormValues = {
  name: string;
  subject: string;
  previewText?: string;
  audienceId: string;
  sendingDomainId: string;
  fromName: string;
  fromEmail: string;
  htmlBody: string;
  textBody?: string;
};

export function CampaignForm({
  initial,
  onSave,
  submitLabel,
}: {
  initial?: Campaign;
  onSave: (values: CampaignFormValues) => Promise<void>;
  submitLabel: string;
}) {
  const api = useApi();
  const [audiences, setAudiences] = useState<Audience[]>([]);
  const [domains, setDomains] = useState<SendingDomain[]>([]);

  const { register, handleSubmit, control, setValue, watch, formState } =
    useForm<CampaignFormValues>({
      defaultValues: initial
        ? {
            name: initial.name,
            subject: initial.subject,
            previewText: initial.previewText ?? "",
            audienceId: initial.audienceId,
            sendingDomainId: initial.sendingDomainId,
            fromName: initial.fromName,
            fromEmail: initial.fromEmail,
            htmlBody: initial.htmlBody,
            textBody: initial.textBody ?? "",
          }
        : { htmlBody: "" },
    });

  useEffect(() => {
    api
      .get<{ audiences: Audience[] }>("/api/audiences")
      .then((res) => setAudiences(res.audiences))
      .catch((err) => toast.error(err.message));
    api
      .get<{ domains: SendingDomain[] }>("/api/domains")
      .then((res) => setDomains(res.domains))
      .catch((err) => toast.error(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const htmlBody = watch("htmlBody");

  const onSubmit = handleSubmit(async (values) => {
    try {
      await onSave(values);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Save failed");
    }
  });

  return (
    <form onSubmit={onSubmit} className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Settings</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 md:grid-cols-2">
          <div className="space-y-2">
            <Label htmlFor="name">Internal name</Label>
            <Input id="name" placeholder="June product update" {...register("name", { required: true })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="subject">Subject</Label>
            <Input id="subject" placeholder="What's new in June" {...register("subject", { required: true })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="previewText">Preview text (optional)</Label>
            <Input id="previewText" {...register("previewText")} />
          </div>
          <div className="space-y-2">
            <Label>Audience</Label>
            <Controller
              control={control}
              name="audienceId"
              rules={{ required: true }}
              render={({ field }) => (
                <Select
                  items={audiences.map((a) => ({ value: a.id, label: a.name }))}
                  value={field.value ?? null}
                  onValueChange={(v) => field.onChange(v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select audience" />
                  </SelectTrigger>
                  <SelectContent>
                    {audiences.map((a) => (
                      <SelectItem key={a.id} value={a.id}>
                        {a.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
          </div>
          <div className="space-y-2">
            <Label>Sending domain</Label>
            <Controller
              control={control}
              name="sendingDomainId"
              rules={{ required: true }}
              render={({ field }) => (
                <Select
                  items={domains.map((d) => ({ value: d.id, label: d.domain }))}
                  value={field.value ?? null}
                  onValueChange={(v) => {
                    field.onChange(v);
                    const domain = domains.find((d) => d.id === v);
                    if (domain?.fromName) setValue("fromName", domain.fromName);
                    if (domain?.fromEmail) setValue("fromEmail", domain.fromEmail);
                  }}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select domain" />
                  </SelectTrigger>
                  <SelectContent>
                    {domains.map((d) => {
                      const verified = domainState(d) === "verified";
                      return (
                        <SelectItem key={d.id} value={d.id} disabled={!verified}>
                          <span>{d.domain}</span>
                          {!verified && (
                            <span className="text-xs text-muted-foreground">needs setup</span>
                          )}
                        </SelectItem>
                      );
                    })}
                  </SelectContent>
                </Select>
              )}
            />
            {domains.length > 0 && domains.every((d) => domainState(d) !== "verified") ? (
              <p className="text-xs text-muted-foreground">
                You can only send from a verified domain.{" "}
                <Link href="/domains" className="underline underline-offset-2 hover:text-foreground">
                  Finish domain setup
                </Link>
                .
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">
                Don&apos;t see your domain?{" "}
                <Link href="/domains" className="underline underline-offset-2 hover:text-foreground">
                  Add or verify a domain
                </Link>
                .
              </p>
            )}
          </div>
          <div className="space-y-2">
            <Label htmlFor="fromName">From name</Label>
            <Input id="fromName" {...register("fromName", { required: true })} />
          </div>
          <div className="space-y-2">
            <Label htmlFor="fromEmail">From email</Label>
            <Input id="fromEmail" {...register("fromEmail", { required: true })} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Content</CardTitle>
        </CardHeader>
        <CardContent>
          <Tabs defaultValue="html">
            <TabsList>
              <TabsTrigger value="html">HTML</TabsTrigger>
              <TabsTrigger value="text">Plain text</TabsTrigger>
              <TabsTrigger value="preview">Preview</TabsTrigger>
            </TabsList>
            <TabsContent value="html" className="space-y-2">
              <Textarea
                rows={16}
                placeholder="<h1>What's new</h1><p>Hi {{first_name}}, …</p>"
                className="font-mono text-xs"
                {...register("htmlBody", { required: true })}
              />
              <p className="text-xs text-muted-foreground">
                Variables: {"{{first_name}}"}, {"{{last_name}}"}, {"{{email}}"}. An unsubscribe
                footer is appended automatically.
              </p>
            </TabsContent>
            <TabsContent value="text">
              <Textarea
                rows={16}
                placeholder="Optional plain-text version (generated from HTML if empty)"
                className="font-mono text-xs"
                {...register("textBody")}
              />
            </TabsContent>
            <TabsContent value="preview">
              <div className="max-h-96 overflow-auto rounded-lg border border-border bg-white p-4">
                <iframe
                  title="Email preview"
                  sandbox=""
                  srcDoc={htmlBody || "<p style='color:#888'>Nothing to preview yet.</p>"}
                  className="h-80 w-full border-0"
                />
              </div>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

      <Button type="submit" disabled={formState.isSubmitting}>
        {submitLabel}
      </Button>
    </form>
  );
}
