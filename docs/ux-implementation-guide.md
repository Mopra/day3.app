# UX journey — implementation guide

Companion to [ux-journey-audit.md](ux-journey-audit.md). This is the *how*: concrete
changes, files, and acceptance per item, ordered for execution. Each item is checked
off as it lands. Verify after each batch: `npm run typecheck` + relevant `npm test`.

**Working branch:** `ux-journey-perfection`. Commit per sub-batch.

---

## Reusable primitives (build once, used everywhere)

- **P-1 `statusLabel` → user-facing label map.** In [format.ts](../src/lib/format.ts),
  add `CAMPAIGN_STATUS_LABELS` / `RECIPIENT_STATUS_LABELS` and a `campaignStatusLabel()`
  that maps internal words to human copy ("generating_recipients" → "Preparing
  recipients", "pending_review" → "In review", "complained" → "Marked as spam", etc.),
  falling back to the underscore-strip. Keep `statusLabel` for generic use.
- **P-2 Distinct status badge variants.** Add an `outline`-ish "info" treatment so
  `scheduled` (clock), `sending` (live dot), `draft`, `pending_review` no longer all
  read as identical grey. Provide `campaignStatusVariant()`.
- **P-3 List load-error state.** A tiny shared helper: pages track `error` alongside
  `view === null`. Render a `ListError` (new, in data-list.tsx) — icon + "Couldn't
  load" + Retry button — instead of an eternal skeleton. Used by all list pages.
- **P-4 Notification service.** `src/services/notifications.ts` — `notifyAccount(db,
  account, {kind, subject, body, ctaHref})` that sends an email via the existing
  `EmailProvider` to the org's admins (Clerk) and writes a row to a new
  `notifications` table for the in-app surface. Fails open (never blocks the caller).
- **P-5 `next-steps` strip.** A small `<NextSteps>` component fed by onboarding state,
  shown on domain/audience/campaign pages while onboarding is incomplete — one CTA to
  the next unfinished milestone.

---

## Batch 1 — Trust (P0)

- **1.1 Kill infinite skeleton.** Apply P-3 to: campaigns, audiences, forms, senders,
  domains, metrics, activity list pages + dashboard. Each `.catch` sets `error`;
  render `ListError` with a retry that re-runs `load()`.
- **1.2 Complete the send preflight.** Extend [onboarding.ts](../src/services/onboarding.ts)
  `computeOnboardingState` to also check `companyAddress` (mailing address) and expose
  it as a blocking reason before domain/subscribers where appropriate; keep content-
  completeness per-campaign. Add address to `OnboardingState`. Update
  [campaign-actions.tsx](../src/components/campaign-actions.tsx) + campaign detail so
  the address gate greys the button with a fix link to /settings, and the confirm
  dialog shows a green preflight checklist (domain ✓ · address ✓ · N recipients ✓).
  `fixLinkFor` gains an address→/settings mapping.
- **1.3 Scheduled-send silent revert.** In [cron.ts](../src/queue/cron.ts), when a
  scheduled send fails re-gating, call P-4 `notifyAccount` ("Your scheduled send didn't
  start: <reason>"). On the campaign detail page, give the reverted-draft alert a
  proper title ("Scheduled send didn't start") instead of the bare status word.
- **1.4 Day-one dashboard signals.** [dashboard/page.tsx](../app/(app)/dashboard/page.tsx):
  on the free plan, the "Sending status" card reads as journey state (neutral dot,
  "Sending unlocks with a paid plan" + Choose a plan), not red "Disabled". Reserve
  red for `risk paused` / `past_due`. Reword/drop the contradictory "active" badge on
  the free Plan card (show "Free plan" plainly).
- **1.5 select-org first-run.** [select-org/page.tsx](../app/select-org/page.tsx):
  replace `null` while loading with a centered spinner/skeleton; when the user has no
  orgs, show first-run copy ("Name your workspace" + plain-language subtext); keep the
  "choose" framing only when orgs exist.
- **1.6 Form-cap visibility.** [form-signup.ts](../src/services/form-signup.ts): when a
  signup is dropped at the cap, increment a counter (Redis or a column) and fire P-4
  once per window ("N signups turned away — you're at the free limit"). Surface on
  dashboard + audience page as an actionable alert linking to /billing.

Acceptance: no dead skeletons; no send-gate failures after confirm; a lapsed schedule
notifies; a fresh free account never shows a red "broken" state; org creation reads as
naming a workspace; capped form signups are surfaced, not silent.

## Batch 2 — Momentum (P1 connective + import honesty)

- **2.1 Next-step CTAs after verify.** Domain verified card (P-5) →
  "Import your audience" / "Create your first campaign".
- **2.2 Mention the auto-created sender** in the verified card + add-domain success
  toast ("We set up <name> <email> as your default sender").
- **2.3 Sent-campaign payoff.** Campaign detail: a one-time success state when status
  flips to `sent` (banner + reduced-motion-safe subtle celebration) with headline
  count, plus deep links "See opens & clicks →" (/metrics?campaign=id) and
  "Troubleshoot a recipient →" (/activity?campaign=id).
- **2.4 Real import progress.** Persist processed/total on the imports row from the
  worker; drive the progress bar from it. If infeasible cheaply, replace the fake bar
  with an honest indeterminate spinner + live row count.
- **2.5 Import completion toast** when polling observes pending→completed.
- **2.6 Import skip breakdown.** Persist per-reason counts (suppressed / invalid /
  duplicate / over-cap) on the import row; render them.
- **2.7 Migration copy in domain setup** (deliverability-migration Feature 1): callout
  about reusing the same subdomain; post-verify expectation copy.

## Batch 3 — Coherence & speed (P1 remainder + P2)

- **3.1 Unify send dialog.** Campaign detail uses `<CampaignActions>` instead of its
  inline copy; delete the duplicate.
- **3.2 Campaign-list badges** (P-2): scheduled shows time + clock; sending animated;
  distinct colors.
- **3.3 Test-email pre-gate.** Friendly 400s for unverified domain / empty content
  before hitting SES.
- **3.4 Domain "Check now" 429.** Disable button briefly after each check / exempt the
  auto-poll; humanize the 429 copy.
- **3.5 Matched skeleton for campaign detail** (replace full-screen loader).
- **3.6 Client cache.** Lightweight SWR-style store so revisiting lists renders cached
  data then revalidates; parallelize dashboard fetches.
- **3.7 Free-cap UX.** Upgrade link in the limit message; "Import the first 500" option.
- **3.8 Feedback consistency:** in-button spinners (settings save, audience create/add,
  schedule); success toasts for make-default + unsubscribe; optimistic senders page;
  export pending state; surface loadImports errors.
- **3.9 Copy pass:** user-facing status labels (P-1) across list, stats, banners; inline
  jargon explanations on domain page; delete-vs-unsubscribe hint in the menu.

## Batch 4 — QOL features

- **4.1 Notifications surface** (in-app bell/list backed by P-4 table).
- **4.2 Per-campaign results tiles** (opens/clicks) on the sent-campaign page.
- **4.3 CSV column-mapping preview** before enqueue.
- **4.4 Undo on deletes** (sonner action / short soft-delete) for campaigns/audiences/
  subscribers.
- **4.5 Cmd+K palette** (navigate + new-campaign/audience/domain).
- **4.6 Sidebar plan pill + usage.**
- **4.7 Test-send nudge** in the send confirm.

---

## Execution log

Progress is tracked in the session todo list; each batch is committed on
`ux-journey-perfection` with a descriptive message.

**Deferred deliberately (correctness over completeness):**
- **3.6 client-side list cache (stale-while-revalidate).** A cache layer applied
  across every page in one pass is a classic source of stale-data-after-mutation
  bugs. The worst waterfall (the dashboard's sequential `sync → account →
  onboarding`) is already fixed by parallelizing it; the remaining
  repeat-visit reflash is a perceived-speed nicety, not a correctness issue.
  Left for a focused follow-up with its own testing rather than shipped hastily.
- **Full send-dialog component unification (3.1).** The detail page's scheduled-
  state banner shares the schedule logic with the submit flow, so a wholesale swap
  to `<CampaignActions>` risked breaking reschedule/cancel. Instead both send-
  confirmation dialogs were made content-identical (same readiness checklist), which
  achieves the user-facing consistency goal without the structural risk.
- **4.4 Undo on deletes.** A real undo needs soft-delete infrastructure (a
  `deleted_at` column + restore endpoints + a retention sweep) across campaigns,
  audiences, and subscribers — a feature in its own right, not a toast tweak.
  Deletes remain protected by an explicit `ConfirmDialog`. Deferred to a focused
  follow-up so it ships with the schema + tests it needs.
- **4.3 CSV column-mapping preview.** A "here's what we detected" step needs a
  preview-parse endpoint and a mapping-confirm UI. The pain it targets (silent
  header-mismatch failures) is now largely mitigated by the honest skip breakdown
  (Batch 2.6) and the sample template. Deferred as a moderate follow-up.

## What shipped (Batch 4 QOL)

- In-app **notification bell** in the sidebar (unread badge, mark-read on open),
  backed by the `notifications` table and `/api/notifications`. Surfaces the
  async events the notification service raises.
- **campaign_sent** notification wired into both send-completion paths (worker
  batch + cron reconcile), guarded so it fires exactly once.
- Sidebar **plan pill** (Free links to billing; paid shows the tier).
- **Cmd/Ctrl+K command palette** for navigation + create actions.
