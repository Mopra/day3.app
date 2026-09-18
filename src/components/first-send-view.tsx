"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  BarChart3,
  Check,
  Globe,
  Lock,
  Mail,
  Send,
  Sparkles,
  Upload,
  Users,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { OrbitLoader } from "@/components/ui/orbit-loader";
import { Reveal } from "@/components/ui/reveal";
import { useApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import type { Account, OnboardingState } from "@/lib/types";

// The dashboard a brand new account sees, in place of the tiles and the
// recent-campaigns table.
//
// It is a different page, not a thinner one. On minute one "Free / 0 of 100 /
// Sandbox" answers no question the user has, and it occupies the position of most
// attention; what they need instead is one obvious way to watch this thing work.
// So the whole page is built around a single action, sending yourself the first
// email, which provisioning has already made possible with no DNS, no import and
// no mailing address (docs/dashboard-day-zero-plan.md §A5).
//
// The checklist underneath is reordered around that reality: see it work, then
// make it yours, then reach real people. DNS is no longer step one; it is what
// you do once you have a reason to.

type ChecklistStep = {
  key: string;
  title: string;
  description: string;
  done: boolean;
  href: string;
  cta: string;
  icon: LucideIcon;
};

export function FirstSendView({
  account,
  onboarding,
}: {
  account: Account;
  onboarding: OnboardingState;
}) {
  const api = useApi();
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [savingPath, setSavingPath] = useState<string | null>(null);

  // The one action. Creates a ready draft (template, team audience, shared
  // domain) and drops the user straight into the composer with Send live.
  async function startFirstCampaign() {
    if (creating) return;
    setCreating(true);
    try {
      const res = await api.post<{ id: string }>("/api/campaigns/first");
      router.push(`/campaigns/${res.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't start your first campaign");
      setCreating(false);
    }
  }

  async function choosePath(path: "has_list" | "building_list") {
    setSavingPath(path);
    try {
      await api.post("/api/account/onboarding/path", { path });
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save that");
    } finally {
      setSavingPath(null);
    }
  }

  // The audience step depends on which path the user said they were on: someone
  // building a list from zero has nothing to import, and pointing them at a CSV
  // uploader reads as a dead end.
  const buildingList = onboarding.onboardingPath === "building_list";
  const audienceStep: ChecklistStep = buildingList
    ? {
        key: "audience",
        title: "Start collecting subscribers",
        description: "Publish a signup form and share the link. People who sign up land in your list.",
        done: onboarding.hasOwnSubscribers,
        href: "/forms",
        cta: "Create a form",
        icon: Users,
      }
    : {
        key: "audience",
        title: "Bring your subscribers in",
        description: "Upload a CSV of the people who already said yes to hearing from you.",
        done: onboarding.hasOwnSubscribers,
        href: "/audiences",
        cta: "Import a CSV",
        icon: Upload,
      };

  const steps: ChecklistStep[] = [
    {
      key: "first-send",
      title: "Send yourself the first one",
      description: "A real email, from the real pipeline, to you and your teammates. Nothing to set up.",
      done: onboarding.hasSentCampaign,
      href: "/campaigns",
      cta: "Start",
      icon: Send,
    },
    {
      key: "domain",
      title: "Send from your own address",
      description: "A few DNS records so mail arrives from your domain instead of ours. We check them for you.",
      done: onboarding.hasVerifiedDomain,
      href: "/sending",
      cta: "Set up my domain",
      icon: Globe,
    },
    audienceStep,
  ];

  const firstSendDone = onboarding.hasSentCampaign;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-2xl sm:text-3xl">Welcome to Day3</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          {firstSendDone
            ? "Your first email is out. Here's what's left before you can reach real subscribers."
            : "Let's get an email into your inbox. It takes about a minute."}
        </p>
      </div>

      {account.riskStatus === "paused" && (
        <Alert variant="destructive">
          <AlertTitle>Sending is paused</AlertTitle>
          <AlertDescription>{account.pausedReason ?? "Contact support."}</AlertDescription>
        </Alert>
      )}

      {/* The hero. Only shown while it is genuinely the next thing: once the
          account has sent, the page keeps the checklist and drops the pitch. */}
      {!firstSendDone && onboarding.canSendFirstEmail && (
        <Reveal>
          <Card className="border-primary/30 bg-primary/[0.04]">
            <CardContent className="flex flex-col gap-5 py-2 sm:flex-row sm:items-center">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-primary/10">
                <Mail className="size-6 text-primary" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-xl">Send yourself a real email</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  We've set you up with a starter design, a test address, and your team as the
                  recipients. No domain, no upload, no settings. Press the button and watch it
                  arrive.
                </p>
                <p className="mt-2 text-xs text-muted-foreground">
                  Goes to{" "}
                  <span className="font-medium text-foreground tabular-nums">
                    {onboarding.teamAudienceSize}
                  </span>{" "}
                  {onboarding.teamAudienceSize === 1 ? "person" : "people"} on your team, and nobody
                  else.
                </p>
              </div>
              <Button
                size="lg"
                className="shrink-0"
                disabled={creating}
                onClick={startFirstCampaign}
              >
                {creating ? <OrbitLoader size={16} /> : <Sparkles className="size-4" />}
                {creating ? "Setting it up" : "Write my first email"}
              </Button>
            </CardContent>
          </Card>
        </Reveal>
      )}

      {/* Fallback when provisioning could not open the day-one path (the shared
          domain is unconfigured, or the org has no members we can mail). Says
          the true next step rather than showing a button that would fail. */}
      {!firstSendDone && !onboarding.canSendFirstEmail && (
        <Reveal>
          <Card>
            <CardContent className="flex flex-col gap-4 py-2 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <h2 className="font-display text-xl">Set up your sending domain</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {onboarding.sendBlockedReason ??
                    "Publish a few DNS records and you can send your first campaign."}
                </p>
              </div>
              <Button className="shrink-0" render={<Link href="/sending">Get started</Link>} />
            </CardContent>
          </Card>
        </Reveal>
      )}

      {/* One question, asked once, and only when there is a reason to: after the
          first send has happened, because before that the answer changes nothing
          on this page. */}
      {firstSendDone && onboarding.onboardingPath === null && (
        <Reveal>
          <Card>
            <CardContent className="space-y-4">
              <div>
                <h2 className="font-medium">Do you already have a list?</h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  So we point you at the right next step. You can change your mind later.
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Button
                  variant="outline"
                  className="flex-1 justify-start"
                  disabled={savingPath !== null}
                  onClick={() => choosePath("has_list")}
                >
                  {savingPath === "has_list" ? <OrbitLoader size={16} /> : <Upload className="size-4" />}
                  Yes, I have subscribers to import
                </Button>
                <Button
                  variant="outline"
                  className="flex-1 justify-start"
                  disabled={savingPath !== null}
                  onClick={() => choosePath("building_list")}
                >
                  {savingPath === "building_list" ? (
                    <OrbitLoader size={16} />
                  ) : (
                    <Users className="size-4" />
                  )}
                  No, I'm starting from zero
                </Button>
              </div>
            </CardContent>
          </Card>
        </Reveal>
      )}

      <Reveal delay={60}>
        <Card>
          <CardContent className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <h2 className="font-medium">Your first three steps</h2>
              <span className="text-sm text-muted-foreground">
                {steps.filter((s) => s.done).length} of {steps.length} done
              </span>
            </div>
            <ol className="space-y-2">
              {steps.map((step) => (
                <li
                  key={step.key}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border p-3",
                    step.done ? "border-border/50 opacity-60" : "border-border",
                  )}
                >
                  <span
                    className={cn(
                      "flex size-8 shrink-0 items-center justify-center rounded-lg",
                      step.done ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
                    )}
                    aria-hidden
                  >
                    {step.done ? <Check className="size-4" /> : <step.icon className="size-4" />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className={cn("text-sm font-medium", step.done && "line-through")}>
                      {step.title}
                    </p>
                    {!step.done && (
                      <p className="mt-0.5 text-xs text-muted-foreground">{step.description}</p>
                    )}
                  </div>
                  {!step.done && (
                    <Link
                      href={step.href}
                      className="shrink-0 text-sm font-medium text-primary underline-offset-4 hover:underline"
                    >
                      {step.cta}
                    </Link>
                  )}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      </Reveal>

      <Reveal delay={120}>
        <PayoffPreview />
      </Reveal>
    </div>
  );
}

// What this page becomes once there is something to show.
//
// Deliberately NOT a mock dashboard with invented numbers: a new user cannot be
// expected to work out which figures on their own dashboard are real, and a
// plausible-looking fake is worse than an empty state. These are labelled,
// locked, number-free descriptions of the real surfaces, so the promise is
// legible without anything pretending to be data.
const PAYOFFS: { icon: LucideIcon; title: string; body: string }[] = [
  {
    icon: Send,
    title: "Watch it go out",
    body: "A live count as your campaign reaches each subscriber.",
  },
  {
    icon: BarChart3,
    title: "See how it landed",
    body: "Opens, clicks and bounces, with how it compares to your own average.",
  },
  {
    icon: Users,
    title: "Track your growth",
    body: "Subscribers gained and lost, week by week.",
  },
];

function PayoffPreview() {
  return (
    <div>
      <div className="mb-3 flex items-center gap-2">
        <Lock className="size-3.5 text-muted-foreground" aria-hidden />
        <h2 className="text-sm font-medium text-muted-foreground">
          After your first send, this page shows you
        </h2>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {PAYOFFS.map((item) => (
          <Card key={item.title} className="border-dashed bg-transparent">
            <CardContent className="space-y-1.5">
              <item.icon className="size-4 text-muted-foreground/60" aria-hidden />
              <p className="text-sm font-medium text-muted-foreground">{item.title}</p>
              <p className="text-xs text-muted-foreground/80">{item.body}</p>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
