"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { PenLine } from "lucide-react";
import { toast } from "sonner";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import type {
  AutomationDetail,
  AutomationTemplateSummary,
  CreateAutomationInput,
} from "@/lib/automation-types";
import type { Audience } from "@/lib/types";

// Sentinel for the "start from scratch" card. Templates are keyed server-side;
// a blank canvas is the absence of one (templateKey: null).
const BLANK = "__blank__";

// The template catalogue changes when we ship, not while a dialog is open, so one
// fetch per page-session is plenty. Module-level so reopening the dialog (or a
// second list mount) doesn't refetch.
let templatesCache: Promise<AutomationTemplateSummary[]> | null = null;

// Create an automation: name it, say whose joining should start it, pick where
// to begin. Templates lead because a blank canvas is exactly where a
// non-technical founder quits (design doc §8); the first one is preselected so
// the fastest path is "type a name, press Create".
export function NewAutomationDialog({
  open,
  onOpenChange,
  audiences,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  audiences: Audience[];
}) {
  const api = useApi();
  const router = useRouter();
  const [name, setName] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const [templateKey, setTemplateKey] = useState<string>(BLANK);
  const [templates, setTemplates] = useState<AutomationTemplateSummary[] | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The name we last filled in from a template. Picking a template names the
  // automation after it unless the user has typed a name of their own.
  const autoName = useRef<string>("");

  useEffect(() => {
    if (!open) return;
    if (!templatesCache) {
      templatesCache = api
        .get<AutomationTemplateSummary[]>("/api/automations/templates")
        .catch((err) => {
          // A failed catalogue read should not block creating an automation, and
          // should not be remembered as "no templates" either.
          templatesCache = null;
          throw err;
        });
    }
    let live = true;
    templatesCache
      .then((rows) => {
        if (!live) return;
        setTemplates(rows);
        if (rows.length > 0) pickTemplate(rows[0]);
      })
      .catch(() => live && setTemplates([]));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // A single audience needs no choosing.
  useEffect(() => {
    if (open && !audienceId && audiences.length === 1) setAudienceId(audiences[0].id);
  }, [open, audienceId, audiences]);

  function pickTemplate(t: AutomationTemplateSummary | null) {
    setTemplateKey(t ? t.key : BLANK);
    setName((cur) => {
      if (cur.trim() && cur !== autoName.current) return cur;
      autoName.current = t ? t.name : "";
      return autoName.current;
    });
  }

  function openChange(next: boolean) {
    onOpenChange(next);
    if (!next) {
      setName("");
      setAudienceId("");
      setTemplateKey(BLANK);
      autoName.current = "";
    }
  }

  async function create() {
    if (!name.trim()) return toast.error("Give your automation a name");
    if (!audienceId) return toast.error("Choose an audience");
    setSubmitting(true);
    try {
      const body: CreateAutomationInput = {
        name: name.trim(),
        audienceId,
        templateKey: templateKey === BLANK ? null : templateKey,
      };
      const detail = await api.post<AutomationDetail>("/api/automations", body);
      toast.success("Automation created");
      openChange(false);
      router.push(`/automations/${detail.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't create the automation");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={openChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>New automation</DialogTitle>
          <DialogDescription>
            Emails that send themselves when someone joins, or when your app says so. Nothing
            goes out until you publish.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="automationName">Name</Label>
            <Input
              id="automationName"
              placeholder="Welcome series"
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              // "Type a name, press Enter" is the fastest path this dialog
              // promises; without a form element Enter would otherwise do nothing.
              onKeyDown={(e) => {
                if (e.key === "Enter" && !submitting) {
                  e.preventDefault();
                  void create();
                }
              }}
            />
            <p className="text-xs text-muted-foreground">Just for you. Subscribers never see it.</p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="automationAudience">Audience</Label>
            <Select
              items={audiences.map((a) => ({ value: a.id, label: a.name }))}
              value={audienceId || null}
              onValueChange={(v) => setAudienceId((v as string) ?? "")}
            >
              <SelectTrigger id="automationAudience" className="w-full">
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
            <p className="text-xs text-muted-foreground">
              Only people in this audience can enter. You can narrow it further afterwards.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label>Start from</Label>
            <div
              role="radiogroup"
              aria-label="Template"
              className="grid grid-cols-1 gap-2 sm:grid-cols-2"
            >
              {templates === null ? (
                <>
                  <Skeleton className="h-[5.5rem] rounded-lg" />
                  <Skeleton className="h-[5.5rem] rounded-lg" />
                  <Skeleton className="h-[5.5rem] rounded-lg" />
                  <Skeleton className="h-[5.5rem] rounded-lg" />
                </>
              ) : (
                <>
                  {templates.map((t) => (
                    <TemplateCard
                      key={t.key}
                      selected={templateKey === t.key}
                      onSelect={() => pickTemplate(t)}
                      name={t.name}
                      description={t.description}
                      meta={`${t.nodeCount} ${t.nodeCount === 1 ? "step" : "steps"}, with draft copy`}
                    />
                  ))}
                  <TemplateCard
                    selected={templateKey === BLANK}
                    onSelect={() => pickTemplate(null)}
                    name="Blank canvas"
                    description="Just the trigger. Add your own steps."
                    meta="Start from scratch"
                    icon
                  />
                </>
              )}
            </div>
          </div>

          <Button onClick={create} disabled={submitting} className="w-full">
            {submitting && <OrbitLoader size={16} />}
            Create automation
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// A template card in the campaign picker's clothes (border, hover lift), minus
// the thumbnail: an automation's shape is a few words, not a picture. The
// selected card reads through the border alone, so it stays neutral.
function TemplateCard({
  selected,
  onSelect,
  name,
  description,
  meta,
  icon,
}: {
  selected: boolean;
  onSelect: () => void;
  name: string;
  description: string;
  meta: string;
  icon?: boolean;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className={cn(
        "flex min-h-[5.5rem] flex-col gap-1 rounded-lg border p-3 text-left transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none",
        selected
          ? "border-foreground/60 bg-muted/50"
          : "border-border hover:border-foreground/30 hover:bg-muted/30",
      )}
    >
      <span className="flex items-center gap-1.5 text-sm font-medium leading-tight">
        {icon && <PenLine className="size-3.5 shrink-0 text-muted-foreground" />}
        {name}
      </span>
      <span className="text-xs leading-snug text-muted-foreground">{description}</span>
      <span className="mt-auto pt-0.5 text-[11px] leading-snug text-muted-foreground/70">
        {meta}
      </span>
    </button>
  );
}
