# UX journey audit — signup → domain → sender → audience → campaign → first send

**Status:** audit complete (2026-07-02), fixes not started.
**Scope:** the golden path a new customer walks, end to end, plus the cross-cutting
polish (feedback, loading, animation, speed) that determines how the whole app feels.
Findings are file-referenced; priorities are P0 (trust breakers) → P1 (golden-path
friction) → P2 (polish) → QOL (missing features).

---

## The journey today — what's already strong

The skeleton is genuinely good. Worth naming so fixes don't regress it:

- **Real server-computed onboarding state** ([onboarding.ts](../src/services/onboarding.ts))
  drives a dashboard checklist and actionable "why can't I send" messages with fix links.
- **Domain setup is the best screen in the app**: stepper rail, per-record status pills,
  click-anywhere copy fields with tooltips, auto-polling with backoff + focus re-check,
  provider-specific help, expectation-setting copy ("most domains verify within an
  hour… up to 48 hours"), and one-click Cloudflare auto-config
  ([domain-setup-guide.tsx](../src/components/domain-setup-guide.tsx)).
- **The composer** autosaves from the first keystroke (draft created in place, URL swaps
  without remount), preselects the sole sender/audience, supports inline sender
  creation, warns inline about missing business address, and has a send-faithful inbox
  preview ([campaign-composer.tsx](../src/components/campaign-composer.tsx)).
- **Consistent list system** ([data-list.tsx](../src/components/ui/data-list.tsx)) —
  every list page uses the same toolbar/skeleton/empty/no-results primitives; empty
  states all have CTAs, several are context-aware (senders page knows you need a
  domain first).
- **Send confirmation** shows live recipient count + audience name + From/Subject;
  deletes all go through one `ConfirmDialog` convention; toasts are consistent.
- **In-flight sends** show an animated banner with a live "X of Y sent" count,
  polling at 2.5s, with pause/resume and a per-recipient table.

The gaps cluster into **four themes**:

1. **Async outcomes go silent** — scheduled sends silently revert, imports finish
   without a word, form signups silently vanish at the cap. The app does async work
   but has no way to tell the user what happened.
2. **Send gates surface inconsistently** — some grey the button with an explanation,
   others explode as a red toast *after* the user confirms the send.
3. **No payoff moments** — domain verified, import complete, campaign sent: each ends
   in a dead-end card instead of celebration + a pointer to the next step.
4. **Failure = dead screen** — any failed initial fetch strands the user on an
   infinite skeleton with no retry.

---

## P0 — trust breakers (fix first)

### P0.1 Failed page load → infinite skeleton, everywhere
Every `(app)` page fetches in `useEffect` and on error only fires a toast — state
stays `null`, so the skeleton renders **forever** ([campaigns/page.tsx:56-60](../app/(app)/campaigns/page.tsx#L56-L60),
same shape in audiences, forms, senders, domains, metrics, activity, dashboard).
One transient hiccup = a dead screen with no recovery except manual refresh.
**Fix:** one shared error state pattern — reuse the `ListEmpty` shape with a
"Couldn't load — Retry" action; apply to all ~8 pages.

### P0.2 Two of the four send gates are post-click explosions
Billing/domain/subscribers block via disabled buttons + an explanatory alert
(preflight from `/api/account/onboarding`). But **mailing address** and **content
completeness** are missing from [computeOnboardingState](../src/services/onboarding.ts#L54-L62)
— a user with everything else in place sees enabled buttons, confirms "Send to
1,200", and *then* gets a raw red toast ([campaigns/[id]/page.tsx:252-262](../app/(app)/campaigns/[id]/page.tsx#L252-L262)).
The point-of-no-return action must never fail on a knowable precondition.
**Fix:** fold address + content checks into the preflight (or a dedicated
per-campaign preflight endpoint) so every gate is a disabled-with-reason, and the
confirm dialog can render a green checklist ("Domain verified ✓ · Address on file ✓
· 1,200 recipients ✓").

### P0.3 Scheduled sends can silently not happen
If a gate lapses at release time, the cron quietly flips the campaign back to
`draft` ([cron.ts:109-119](../src/queue/cron.ts#L109-L119)). No email, no toast, no
banner anywhere — the user finds out only if they reopen the campaign, where the
alert's title is the bare word **"draft"** ([campaigns/[id]/page.tsx:476-481](../app/(app)/campaigns/[id]/page.tsx#L476-L481)).
A founder can believe a newsletter went out when it didn't.
**Fix (minimum):** a prominent dashboard/campaign-list banner for "a scheduled send
didn't start", proper alert title/copy. **Fix (right):** email the account when a
scheduled send fails to release (see QOL.1).

### P0.4 A healthy new account looks broken
Day-one free account: **red dot + "Sending status: Disabled" + "Sending is turned
off"** ([dashboard/page.tsx:97-103, 204-219](../app/(app)/dashboard/page.tsx#L97-L103))
directly beside a Plan card badge reading **"active"** ([dashboard/page.tsx:146-155](../app/(app)/dashboard/page.tsx#L146-L155)).
Red + "Disabled" reads as *fault*, not as the expected free tier; the two cards
contradict each other.
**Fix:** on free plan, the sending card should read as journey state, not error —
e.g. neutral dot, "Sending unlocks with a paid plan" + link; reserve red for
risk-paused/past-due. Drop or reword the "active" badge on the free plan card.

### P0.5 "Choose your organization" — a choice with nothing to choose
New users bounce signup → `/dashboard` → `/select-org`, which renders `null` while
Clerk loads (blank flash, [select-org/page.tsx:17](../app/select-org/page.tsx#L17)),
then asks them to "Choose your organization" with multi-tenant jargon — but a
first-run user has zero orgs; the only action is Create ([select-org/page.tsx:22-31](../app/select-org/page.tsx#L22-L31)).
**Fix:** loading skeleton instead of `null`; first-run copy that says what it is —
"Name your workspace" / "One last step — what should we call your company?"; keep
the chooser framing only when the user actually has orgs to pick from.

### P0.6 Form signups silently vanish at the free cap
At 500 subscribers, a public form signup is **dropped** while the visitor still
sees the success message, and the owner is never told ([form-signup.ts:64-77](../src/services/form-signup.ts#L64-L77)).
Real signups are being lost invisibly — a trust and data-loss issue.
**Fix:** surface it — dashboard banner + audience-page alert ("Your list is at the
free limit; N signups were turned away this week — upgrade to keep collecting"),
and count the drops so the message is concrete.

---

## P1 — golden-path friction

### Momentum between steps (the connective tissue)

- **P1.1 Domain verified → dead end.** The success card says "you can send from it
  now" but offers no next step ([domain-setup-guide.tsx:667-684](../src/components/domain-setup-guide.tsx#L667-L684)).
  The dashboard checklist exists but lives only on the dashboard.
  **Fix:** verified state gets a CTA pair driven by onboarding state — "Import your
  audience →" / "Create your first campaign →". Consider a small next-step strip on
  every core page while onboarding is incomplete.
- **P1.2 The auto-created sender is invisible.** Adding a domain creates the default
  sender ([domains/route.ts:62-78](../app/api/domains/route.ts#L62-L78)) but nothing
  ever tells the user. Later, the Senders page and the composer From-dropdown are the
  first they hear of it. **Fix:** one line in the verified card ("We've set up
  *Jane from Acme <news@acme.com>* as your default sender — edit in Senders").
- **P1.3 Campaign sent → no payoff.** The animated send banner builds anticipation,
  then the page just becomes a stats table. No "It's out 🎉 — delivered to 1,200
  inboxes", no links from a sent campaign to [Metrics](../app/(app)/metrics/page.tsx)
  or [Activity](../app/(app)/activity/page.tsx) (neither filtered nor global).
  This is the emotional peak of the product and it's flat. **Fix:** a one-time
  sent-success state (banner or subtle confetti, respecting reduced-motion) + a
  "See opens & clicks →" deep link to Metrics filtered to the campaign, and
  "Troubleshoot a recipient →" to Activity.

### Import feedback (currently fiction)

- **P1.4 The progress bar is fake** — hardcoded 5% (pending) / 50% (processing)
  ([audiences/[id]/page.tsx:523-525](../app/(app)/audiences/[id]/page.tsx#L523-L525)).
  A big import parked at 50% reads as a hang. **Fix:** report real progress from the
  worker (processed/total on the imports row), or drop the bar for an honest
  indeterminate spinner + row counts.
- **P1.5 No completion signal.** Upload toasts "Import started"; completion is a
  badge flip on the next 2s poll. **Fix:** toast on completion ("1,480 imported ·
  20 skipped") when polling observes the flip.
- **P1.6 "N skipped" is a black box.** Suppressed, invalid, duplicate, and over-cap
  rows all collapse into one number ([process-import.ts:123](../src/queue/handlers/process-import.ts#L123));
  `invalidRows` is computed but never surfaced ([csv.ts:187-190](../src/lib/csv.ts#L187-L190)).
  **Fix:** persist a per-reason breakdown on the import row and render it
  ("12 already subscribed · 5 invalid emails · 3 previously unsubscribed").

### Send-flow coherence

- **P1.7 The send-confirmation moment is duplicated and drifting.** The full action
  cluster + dialogs exist twice: [campaign-actions.tsx](../src/components/campaign-actions.tsx#L248-L309)
  and inline in [campaigns/[id]/page.tsx:719-773](../app/(app)/campaigns/[id]/page.tsx#L719-L773)
  (already differ: one renders the fix link in-dialog). **Fix:** the detail page
  should use `CampaignActions` — one implementation of the most important dialog.
- **P1.8 Campaign list hides schedule state.** `scheduled`, `draft`, `sending`,
  `pending_review`, `generating_recipients` all share the same grey badge
  ([format.ts:49-56](../src/lib/format.ts#L49-L56)), and the scheduled *time* isn't
  shown anywhere in the list. **Fix:** distinct badge colors/icons per phase
  (scheduled = clock + time, sending = animated dot), and show "Sends {date}" in
  place of Created for scheduled rows.
- **P1.9 Test email has no pre-gate (WIP).** The new route sends straight to the
  provider, so unverified domain / empty draft fail as raw per-address SES errors
  ([test-email/route.ts:36-66](../app/api/campaigns/[id]/test-email/route.ts#L36-L66)).
  **Fix:** cheap pre-checks (verified domain, subject/body present) returning
  friendly 400s before touching SES.
- **P1.10 Domain "Check now" can 429.** Manual clicks share the 12/60s
  `domain_recheck` bucket with the auto-poll ([rate-limit.ts:59-61](../src/lib/rate-limit.ts#L59-L61));
  impatient users see "Too many requests" — reads as breakage during the most
  anxious wait in the product. **Fix:** disable the button briefly after each check /
  exempt the visible auto-poll from the manual budget, and make the 429 copy human
  ("Still checking — DNS can take a while. We're watching it for you.").

### Speed & perceived performance

- **P1.11 Campaign detail blanks the whole panel** with a full-screen loader
  ([campaigns/[id]/page.tsx:338](../app/(app)/campaigns/[id]/page.tsx#L338)) then
  layout-shifts in — the only core page without a matched skeleton. **Fix:** matched
  content skeleton keeping the header in place.
- **P1.12 Refetch-everything navigation.** No client cache: every visit reflashes
  skeletons; the dashboard chains `sync → account → onboarding` sequentially
  ([dashboard/page.tsx:71-92](../app/(app)/dashboard/page.tsx#L71-L92)); AppShell
  re-fetches `/api/account/me` every mount. **Fix:** a small SWR-style cache (or
  module store) so back-navigation renders instantly and re-validates in the
  background; parallelize the dashboard chain (sync once, then account ∥ onboarding
  ∥ campaigns).
- **P1.13 Free-cap UX.** The limit message has no upgrade link
  ([subscriber-limit.ts:35-39](../src/services/subscriber-limit.ts#L35-L39)); a
  601-row import into an empty free account imports **zero** (all-or-nothing 403,
  [import/route.ts:47-55](../app/api/audiences/[id]/import/route.ts#L47-L55)).
  **Fix:** link the toast/alert to /billing; offer "Import the first 500" as an
  explicit choice.

---

## P2 — polish (the small stuff that adds up)

**Feedback consistency**
- Missing in-button spinners: Settings save, audience Create, add-subscriber Add;
  text-only "Scheduling…" / "Loading…" — standardize on the `OrbitLoader`-in-button
  pattern used elsewhere.
- Silent successes: sender "Make default" ([senders/page.tsx:169-182](../app/(app)/senders/page.tsx#L169-L182))
  and subscriber "Unsubscribe" fire no success toast.
- Senders page reloads the whole list after every mutation while the composer's
  inline add and the audiences page are optimistic — pick optimistic everywhere.
- CSV export is a raw `<a download>` with no pending state — looks dead on big lists.
- `loadImports` errors are swallowed entirely ([audiences/[id]/page.tsx:218](../app/(app)/audiences/[id]/page.tsx#L218)).

**Safety & recoverability**
- No undo anywhere; every delete is "can't be undone" behind one confirm. Add a
  sonner `action` undo (or short soft-delete) for campaigns/audiences/subscribers.
- Import retry route skips the headroom re-check the initial upload performs
  ([retry route](../app/api/audiences/[id]/imports/[importId]/retry/route.ts)).
- Admin: `window.prompt()` for pause/block reasons; Resume/Override-verify have no
  confirm — off the documented convention.

**Copy & vocabulary**
- Raw internal status words in user-facing UI: "generating recipients",
  "pending review", "skipped", "complained"; the reverted-schedule alert titled
  "draft". Introduce a user-facing label map ("Preparing recipients…",
  "In review", "Couldn't be delivered").
- Domain jargon on the primary surface: "Return-Path pending", "DKIM",
  "finalizing" — one-line inline explanations, not just collapsed help.
- Delete vs Unsubscribe distinction only explained inside the confirm dialog —
  hint it in the menu itself.

**Domain-setup edge cases**
- Zone-file hosts: relative-only record names with no "show full name" toggle, and
  no trailing-dot caveat for CNAME/MX ([domain-setup-guide.tsx help section](../src/components/domain-setup-guide.tsx#L1080-L1139)).
- The `/check` route rewrites `updatedAt` on every poll ([check/route.ts:51](../app/api/domains/[id]/check/route.ts#L51)),
  so the 14-day stale timer effectively never elapses while the page is open; the
  list shows "Verifying…" indefinitely for a domain whose DNS was never added.

**First-run**
- Onboarding checklist pops in a beat after the stat cards (no skeleton reserved).
- No plan indicator in the persistent sidebar — free state is only on
  dashboard/billing. A small plan pill near the org switcher orients every screen.
- Checklist step 1 is DNS — the most technical task first. Consider reordering to
  "Import your audience" first (no dependency), or at least frame step 1's scary
  part ("~5 minutes; we'll watch DNS for you").

**Motion & feel**
- Skeleton → content is a hard swap; a ~150ms fade would soften every page load.
- Route changes pop; list add/remove isn't animated.
- Org switch is a full `window.location.reload()` white flash ([app-shell.tsx:117-133](../src/components/app-shell.tsx#L117-L133)).
- Dead code: `Cmd+B` wired in an unused sidebar component ([ui/sidebar.tsx:100](../src/components/ui/sidebar.tsx#L100)).

**Sundry**
- Audience header shows only "N subscribed" though the full per-status `counts`
  map is already fetched — show the breakdown chips.
- Composer subject counter turns amber at 60 chars (good) — mirror the same
  treatment for preview text length.
- Send-confirm shows "Send now" while the recipient count loads — hold the button
  in a loading state until the count resolves so the label is always concrete.

---

## QOL — missing features surfaced by this audit

1. **A notification channel for async outcomes** (the single biggest theme).
   Email (via the existing provider) + a lightweight in-app surface for:
   scheduled send released/failed-to-release, send completed (with headline
   stats), import completed/failed, form signups dropped at cap, account
   auto-paused. Without this, everything that happens while the tab is closed
   is invisible.
2. **Per-campaign results on the campaign page** — opens/clicks summary tiles on a
   sent campaign + deep links to Metrics (filtered) and Activity (filtered).
   The data already exists; the campaign page just doesn't show engagement.
3. **CSV column-mapping preview** — a "here's what we detected" step (email ✓,
   first_name ✓, 2 custom fields) before enqueueing, so header mismatches
   ("Email Address") don't fail whole imports or silently become custom fields.
4. **Test-send nudge in the send confirm** — "You haven't sent yourself a test of
   this campaign" checkbox-style hint (track last test per campaign).
5. **Undo window on deletes** (see P2) — cheapest possible "instant gratification
   with a safety net".
6. **Cmd+K palette** — navigate + "new campaign/audience/domain" actions; the app
   is keyboard-friendly enough that its absence is felt.
7. **Suppression-list import + migration copy** — already designed in
   [deliverability-migration.md](deliverability-migration.md) (Features 1, 2, 4);
   Feature 1 (domain-setup migration copy) is a day of work and belongs with P1.1.
8. **Sidebar plan pill + usage** — plan name and, when paid, month usage at a
   glance near the org switcher.

---

## Suggested attack order

| Batch | Contents | Why first |
|-------|----------|-----------|
| **1 — Trust** | P0.1–P0.6 | Dead screens, post-confirm send failures, silent non-sends, day-one broken signals — each one costs believability. |
| **2 — Momentum** | P1.1–P1.6 (next-step CTAs, sender mention, sent payoff, honest import feedback) | Turns the journey from six disconnected rooms into one guided flow with payoffs. |
| **3 — Coherence & speed** | P1.7–P1.13 + P2 feedback/consistency items | One send dialog, honest badges, cache + skeletons + spinners — the "feels fast and finished" layer. |
| **4 — QOL features** | Notifications (QOL.1), campaign results (QOL.2), CSV mapping (QOL.3), then the rest | Real features; sequence after the flow itself is sound. |

Batches 1–2 are the "absolutely perfect flow" work; 3 is feel; 4 is compounding value.
