"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAuth } from "@clerk/nextjs";
import {
  CheckoutButton,
  SubscriptionDetailsButton,
  usePlans,
} from "@clerk/nextjs/experimental";
import { Check, CheckIcon, Loader2Icon, Minus } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Slider } from "@/components/ui/slider";
import { Textarea } from "@/components/ui/textarea";
import { useApi, ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  FREE_PLAN,
  PLAN_ORDER,
  isPlanKey,
  nextPlanUp,
  planMeta,
  type PlanKey,
  type PlanMeta,
} from "@/lib/plans-catalog";
import type { Account } from "@/lib/types";
import { usageInfo } from "@/components/plan-usage";

// The headline differentiators per tier — bandwidth, AI access, and the
// subscriber cap — so the comparison is honest about what each tier gates.
function planFeatures(meta: PlanMeta): { ok: boolean; label: string }[] {
  return [
    meta.sendingEnabled
      ? { ok: true, label: `Send up to ${meta.monthlyEmailLimit.toLocaleString()}/mo` }
      : { ok: false, label: "Set-up & drafts (no sending)" },
    meta.aiEnabled
      ? { ok: true, label: "AI writing assistant" }
      : { ok: false, label: "AI assistant on 10k & up" },
    {
      ok: true,
      label:
        meta.maxSubscribers === null
          ? "Unlimited subscribers"
          : `Up to ${meta.maxSubscribers.toLocaleString()} subscribers`,
    },
    { ok: true, label: "All other features included" },
  ];
}

// The CTA wiring is unchanged from the old grid — a paid switch goes through
// <CheckoutButton> (Clerk handles proration), and "Downgrade to Free" opens
// <SubscriptionDetailsButton> where the org cancels its paid subscription (Clerk
// moves it to the default free plan).
function PlanCta({
  plan,
  label,
  variant,
  planId,
  hasOrg,
  onChanged,
}: {
  plan: PlanKey;
  label: string;
  variant: "default" | "outline";
  planId: string | undefined;
  hasOrg: boolean;
  onChanged?: () => void;
}) {
  const button = (
    <Button variant={variant} size="sm" className="w-full">
      {label}
    </Button>
  );

  if (plan === FREE_PLAN) {
    if (!hasOrg) {
      return (
        <Button variant={variant} size="sm" className="w-full" disabled>
          {label}
        </Button>
      );
    }
    return (
      <SubscriptionDetailsButton for="organization" onSubscriptionCancel={onChanged}>
        {button}
      </SubscriptionDetailsButton>
    );
  }

  if (!hasOrg || !planId) {
    return (
      <Button variant={variant} size="sm" className="w-full" disabled>
        {label}
      </Button>
    );
  }
  return (
    <CheckoutButton
      planId={planId}
      planPeriod="month"
      for="organization"
      onSubscriptionComplete={onChanged}
    >
      {button}
    </CheckoutButton>
  );
}

// Fixed card width (in rem) — the scroll padding centers the active card by
// reserving half the leftover track width on each side, so card 0 and the last
// card can both sit dead-center with their neighbors peeking in.
const CARD_W_REM = 18; // matches w-72

// Past the top of the ladder there is no self-serve tier — orgs that need more
// than the 100k allowance reach out and we set them up manually. The carousel
// carries one extra "contact us" card after the last plan; it shares the slider
// track but has no Clerk plan behind it.
const CONTACT_INDEX = PLAN_ORDER.length;
const CONTACT_EMAIL = "connect@day3.app";

// The contact card's CTA: a small in-app form (same shape as the sidebar Help
// widget) that relays through POST /api/support with topic "volume", so the
// user writes to us directly instead of bouncing out to their mail client.
function ContactVolumeDialog() {
  const api = useApi();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Reset everything whenever the dialog closes so a reopen starts fresh.
  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) {
      setMessage("");
      setSending(false);
      setSent(false);
      setError(null);
    }
  }

  async function handleSend() {
    const trimmed = message.trim();
    if (!trimmed || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.post("/api/support", { message: trimmed, topic: "volume" });
      setSent(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't send your message. Please try again.",
      );
    } finally {
      setSending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger
        render={<Button variant="default" size="sm" className="w-full" />}
      >
        Contact us
      </DialogTrigger>
      <DialogContent>
        {sent ? (
          <div className="flex flex-col items-center gap-2 py-6 text-center">
            <span className="flex size-9 items-center justify-center rounded-full bg-muted text-foreground">
              <CheckIcon className="size-5" />
            </span>
            <p className="font-medium">Message sent</p>
            <p className="text-xs text-muted-foreground">
              Thanks — we read every message and will get back to you by email.
            </p>
          </div>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Sending more than 100k / month?</DialogTitle>
              <DialogDescription>
                Tell us roughly how many emails you send and how often — we&apos;ll
                size a plan for you and reply by email.
              </DialogDescription>
            </DialogHeader>
            <Textarea
              autoFocus
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void handleSend();
                }
              }}
              placeholder="e.g. We send ~250,000 emails a month across two weekly newsletters…"
              rows={5}
              className="min-h-28 resize-none text-sm"
            />
            {error && <p className="text-xs text-destructive">{error}</p>}
            <DialogFooter className="items-center sm:justify-between">
              <span className="text-xs text-muted-foreground">
                Or email{" "}
                <a
                  href={`mailto:${CONTACT_EMAIL}`}
                  className="text-foreground underline underline-offset-2 hover:text-primary"
                >
                  {CONTACT_EMAIL}
                </a>
              </span>
              <Button
                size="sm"
                onClick={handleSend}
                disabled={!message.trim() || sending}
              >
                {sending && <Loader2Icon className="size-3.5 animate-spin" />}
                Send
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

// The plan picker, as a focus carousel. Every Day3 feature is on every tier, so
// the only axis that changes is the monthly email allowance — the user slides
// along the bandwidth ladder ("how many emails per month?", free → 100k) and the
// matching tier card snaps into focus below, scaled up while its neighbors dim.
// The slider and the horizontal scroll position are two views of the same focused
// index: dragging the slider scrolls the track, and scrolling the track moves the
// slider. The focused card's CTA drives Clerk Billing directly; `onChanged` lets
// the parent re-sync the account after a change.
export function PlanSlider({
  account,
  onChanged,
}: {
  account: Account;
  onChanged?: () => void;
}) {
  const { orgId } = useAuth();
  // Clerk's org plans, keyed by slug — our PlanKey IS the Clerk slug, so this
  // resolves each tier to the Clerk plan id <CheckoutButton> needs.
  const { data: clerkPlans } = usePlans({ for: "organization" });
  const planIdBySlug = new Map(
    (clerkPlans ?? []).map((p) => [p.slug, p.id] as const),
  );

  const info = usageInfo(account);
  const currentPlan: PlanKey | null = isPlanKey(account.plan) ? account.plan : null;
  const currentIndex = currentPlan ? PLAN_ORDER.indexOf(currentPlan) : -1;

  // Open the carousel on the org's current plan (or the free tier for an
  // unrecognized/legacy value).
  const [index, setIndex] = useState(currentIndex >= 0 ? currentIndex : 0);
  // Mirror of `index` for the resize/init handlers to read without re-subscribing.
  const indexRef = useRef(index);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const cardRefs = useRef<(HTMLDivElement | null)[]>([]);
  // True while we're animating the track ourselves (slider drag / card click), so
  // the scroll listener doesn't fight the slider by re-deriving the index from the
  // in-flight scroll position. Cleared shortly after the animation settles.
  const syncing = useRef(false);
  const syncTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const raf = useRef<number | null>(null);

  // Scroll the track so card `i` sits centered. getBoundingClientRect keeps this
  // correct regardless of the card's offset parent or the current scroll position.
  const centerOn = useCallback((i: number, behavior: ScrollBehavior) => {
    const scroller = scrollerRef.current;
    const card = cardRefs.current[i];
    if (!scroller || !card) return;
    const sRect = scroller.getBoundingClientRect();
    const cRect = card.getBoundingClientRect();
    const delta = cRect.left + cRect.width / 2 - (sRect.left + sRect.width / 2);
    if (Math.abs(delta) < 1) return;
    syncing.current = true;
    scroller.scrollTo({ left: scroller.scrollLeft + delta, behavior });
    if (syncTimer.current) clearTimeout(syncTimer.current);
    syncTimer.current = setTimeout(() => {
      syncing.current = false;
    }, 700);
  }, []);

  // Move focus from an explicit pick (slider drag, card or "Select" click): set the
  // index immediately so the slider thumb tracks 1:1, then glide the track to it.
  const focusTo = useCallback(
    (i: number) => {
      setIndex(i);
      centerOn(i, "smooth");
    },
    [centerOn],
  );

  // While the user scrolls the track directly, derive the focused index from the
  // card nearest the track's center.
  const onScroll = useCallback(() => {
    if (syncing.current || raf.current != null) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = null;
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const sRect = scroller.getBoundingClientRect();
      const center = sRect.left + sRect.width / 2;
      let best = 0;
      let bestDist = Infinity;
      cardRefs.current.forEach((el, i) => {
        if (!el) return;
        const r = el.getBoundingClientRect();
        const d = Math.abs(r.left + r.width / 2 - center);
        if (d < bestDist) {
          bestDist = d;
          best = i;
        }
      });
      setIndex((prev) => (prev === best ? prev : best));
    });
  }, []);

  // Center the initial plan before the first paint — synchronous (no rAF) so the
  // track never flashes at scrollLeft 0, and idempotent so React's double-invoke in
  // development is harmless (it just centers the same card twice). Card refs are set
  // during commit, before layout effects, so the measurement is ready here.
  useLayoutEffect(() => {
    centerOn(indexRef.current, "auto");
  }, [centerOn]);

  // Keep the focused card centered across viewport resizes.
  useEffect(() => {
    const onResize = () => centerOn(indexRef.current, "auto");
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [centerOn]);

  useEffect(
    () => () => {
      if (syncTimer.current) clearTimeout(syncTimer.current);
    },
    [],
  );

  const onContact = index === CONTACT_INDEX;
  const meta = planMeta(PLAN_ORDER[Math.min(index, PLAN_ORDER.length - 1)]);

  // Only nudge a specific upgrade once the account is actually running low; an org
  // comfortably within its allowance shouldn't see a pushy "Recommended".
  const recommended: PlanKey | null =
    currentPlan && info.state !== "ok" ? nextPlanUp(currentPlan) : null;

  return (
    <div className="space-y-7">
      {/* Big live readout of the focused tier — slide to change it. */}
      <div className="space-y-4">
        <div className="flex items-end justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">
              How many emails do you send per month?
            </p>
            <p className="mt-0.5 text-3xl font-semibold tracking-tight tabular-nums">
              {onContact ? (
                <>
                  100,000+
                  <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                    emails / mo
                  </span>
                </>
              ) : meta.sendingEnabled ? (
                <>
                  {meta.monthlyEmailLimit.toLocaleString()}
                  <span className="ml-1.5 text-sm font-normal text-muted-foreground">
                    emails / mo
                  </span>
                </>
              ) : (
                "Set-up only"
              )}
            </p>
          </div>
          <div className="text-right">
            <p className="text-sm text-muted-foreground">
              {onContact ? "Custom plan" : `${meta.name} plan`}
            </p>
            <p className="text-xl font-semibold tracking-tight">
              {onContact ? (
                "Let's talk"
              ) : (
                <>
                  ${meta.monthlyPriceUsd}
                  <span className="text-sm font-normal text-muted-foreground">/mo</span>
                </>
              )}
            </p>
          </div>
        </div>

        <Slider
          aria-label="Monthly email volume"
          value={index}
          onValueChange={(v) => focusTo(Array.isArray(v) ? v[0] : (v as number))}
          min={0}
          max={CONTACT_INDEX}
          step={1}
        />

        <div className="flex justify-between text-xs text-muted-foreground tabular-nums">
          <span>0 / mo</span>
          <span>100k+ / mo</span>
        </div>
      </div>

      {/* The focus carousel: every tier, scaled up when in focus, dimmed otherwise.
          Edge gradients fade the peeking neighbors into the card background. */}
      <div className="relative -mx-4">
        <div
          ref={scrollerRef}
          onScroll={onScroll}
          // Pad each side by half the leftover track width so the first and last
          // cards can sit centered (kept in lockstep with CARD_W_REM).
          style={{ paddingInline: `max(1rem, calc(50% - ${CARD_W_REM / 2}rem))` }}
          className="flex snap-x snap-mandatory gap-4 overflow-x-auto overflow-y-hidden py-8 [-ms-overflow-style:none] [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
        >
          {PLAN_ORDER.map((plan, i) => {
            const m = planMeta(plan);
            const active = i === index;
            const isCurrent = plan === currentPlan;
            const isRecommended = recommended !== null && plan === recommended;
            const isUpgrade = currentIndex >= 0 && i > currentIndex;

            return (
              <div
                key={plan}
                ref={(el) => {
                  cardRefs.current[i] = el;
                }}
                onClick={() => !active && focusTo(i)}
                style={{ width: `${CARD_W_REM}rem` }}
                className={cn(
                  // In Tailwind v4 the scale/lift use the standalone `scale` and
                  // `translate` properties, so they must be named in the transition
                  // (a bare `transform` wouldn't animate them). The easeOutQuint-ish
                  // curve settles the focus change smoothly alongside the scroll.
                  "relative flex shrink-0 snap-center flex-col rounded-2xl border bg-card p-5 transition-[scale,translate,opacity,box-shadow,border-color] duration-[450ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform",
                  active
                    ? cn(
                        "-translate-y-1 scale-100 opacity-100 shadow-xl",
                        isRecommended
                          ? "border-primary ring-1 ring-primary"
                          : "border-foreground/30",
                      )
                    : "scale-90 cursor-pointer border-border opacity-45 hover:opacity-70",
                )}
              >
                {(isCurrent || isRecommended) && (
                  <Badge
                    variant={isRecommended ? "default" : "outline"}
                    className="absolute right-4 top-4"
                  >
                    {isRecommended ? "Recommended" : "Current"}
                  </Badge>
                )}

                <div className="text-sm font-medium text-muted-foreground">{m.name}</div>
                <div className="mt-1 flex items-baseline gap-1">
                  <span className="text-3xl font-semibold tracking-tight">
                    ${m.monthlyPriceUsd}
                  </span>
                  <span className="text-sm text-muted-foreground">/mo</span>
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {m.monthlyEmailLimit.toLocaleString()} emails / month
                </div>

                <ul className="mt-4 space-y-1.5 text-sm">
                  {planFeatures(m).map((f) => (
                    <li
                      key={f.label}
                      className={cn(
                        "flex items-center gap-2",
                        f.ok ? "text-muted-foreground" : "text-muted-foreground/60",
                      )}
                    >
                      {f.ok ? (
                        <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                      ) : (
                        <Minus className="h-4 w-4 shrink-0" aria-hidden />
                      )}
                      {f.label}
                    </li>
                  ))}
                </ul>

                <div className="mt-5 flex-1" />
                {/* The real billing CTA only lives on the focused card; the others
                    show a "Select" that brings them into focus first. */}
                {active ? (
                  isCurrent ? (
                    <Button variant="outline" size="sm" disabled className="w-full">
                      Current plan
                    </Button>
                  ) : (
                    <PlanCta
                      plan={plan}
                      variant={isRecommended || isUpgrade ? "default" : "outline"}
                      planId={planIdBySlug.get(plan)}
                      hasOrg={Boolean(orgId)}
                      onChanged={onChanged}
                      label={
                        plan === FREE_PLAN
                          ? "Downgrade to Free"
                          : isUpgrade || currentIndex < 0
                            ? `Upgrade to ${m.name}`
                            : `Switch to ${m.name}`
                      }
                    />
                  )
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full"
                    tabIndex={-1}
                    onClick={() => focusTo(i)}
                  >
                    Select
                  </Button>
                )}
              </div>
            );
          })}

          {/* Beyond the ladder: no self-serve tier above 100k, so the last card
              asks the org to get in touch instead of offering a checkout. */}
          <div
            ref={(el) => {
              cardRefs.current[CONTACT_INDEX] = el;
            }}
            onClick={() => !onContact && focusTo(CONTACT_INDEX)}
            style={{ width: `${CARD_W_REM}rem` }}
            className={cn(
              "relative flex shrink-0 snap-center flex-col rounded-2xl border border-dashed bg-card p-5 transition-[scale,translate,opacity,box-shadow,border-color] duration-[450ms] ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform",
              onContact
                ? "-translate-y-1 scale-100 border-foreground/30 opacity-100 shadow-xl"
                : "scale-90 cursor-pointer border-border opacity-45 hover:opacity-70",
            )}
          >
            <div className="text-sm font-medium text-muted-foreground">Need more?</div>
            <div className="mt-1 flex items-baseline gap-1">
              <span className="text-3xl font-semibold tracking-tight">Custom</span>
            </div>
            <div className="mt-1 text-sm text-muted-foreground">
              More than 100,000 emails / month
            </div>

            <ul className="mt-4 space-y-1.5 text-sm">
              {[
                "Volume and pricing sized to you",
                "AI writing assistant",
                "Unlimited subscribers",
                "All other features included",
              ].map((label) => (
                <li key={label} className="flex items-center gap-2 text-muted-foreground">
                  <Check className="h-4 w-4 shrink-0 text-primary" aria-hidden />
                  {label}
                </li>
              ))}
            </ul>

            <div className="mt-5 flex-1" />
            {onContact ? (
              <ContactVolumeDialog />
            ) : (
              <Button
                variant="ghost"
                size="sm"
                className="w-full"
                tabIndex={-1}
                onClick={() => focusTo(CONTACT_INDEX)}
              >
                Select
              </Button>
            )}
          </div>
        </div>

        <div className="pointer-events-none absolute inset-y-0 left-0 w-10 bg-gradient-to-r from-card to-transparent" />
        <div className="pointer-events-none absolute inset-y-0 right-0 w-10 bg-gradient-to-l from-card to-transparent" />
      </div>
    </div>
  );
}
