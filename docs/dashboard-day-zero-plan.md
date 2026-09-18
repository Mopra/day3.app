# Plan A: day zero (signup to first email)

**Status: implemented 2026-09-18.** Kept as the design record: it says why each
piece is shaped the way it is. For how the shipped flow behaves and how to
exercise it, see `docs/onboarding-walkthrough.md`.

Two notes on what the code turned out to need beyond this plan:

- **A9 needed no work.** The composer already opens its template picker for a
  brand-new campaign (`campaign-composer.tsx`), for the reason A9 gives.
- **The test-send path was a hole this plan missed.** `sendCampaignTest` lets the
  caller name its own recipients, so without a check there it would have been the
  way to send shared-domain mail to any stranger. It now restricts shared-domain
  tests to org members, like every other surface.
- **Provisioning also writes a sender row**, so the shared address is an ordinary
  option in every From dropdown rather than a special case each one has to learn.
  That in turn meant `POST /api/senders` had to stop counting it when deciding
  whether a new sender is the account's default.

**Companion:** `docs/dashboard-signal-plan.md` (Plan B), which covers the dashboard
once an account is actually sending. Read both before starting either: they share
one file (`app/(app)/dashboard/dashboard-view.tsx`) and the ordering matters.

## The problem

A brand new org must clear four chores before a single email leaves the building:

1. a business mailing address (`campaignSendGateError`, `src/api/campaigns.ts`),
2. a DNS-verified sending domain (same gate),
3. an audience with at least one subscribed contact (same gate),
4. teammates present in that audience, because a free account sends in sandbox
   mode and sandbox reaches org members only (same gate, `opts.sandbox` branch).

Step one of the dashboard checklist (`src/components/onboarding-checklist.tsx`) is
"Verify a sending domain", which means DNS records on minute one. For the
non-technical operators this product is built for, that is the highest cliff in
the whole app placed at the point of lowest investment. Nothing has proved itself
yet, so there is no reason to climb.

Compounding it: every interesting thing the dashboard could show is empty on day
zero. No campaign to watch send, no scorecard, no subscribers to chart. The
day-zero dashboard is not a thinner version of the real one. It is a different
page with a different job, and today it does not exist.

## The shape of the fix

**Let the first email arrive before any setup, then ask for the paperwork.**

Sandbox mode already permits a real send to the org's own members, metered on the
one ledger. The only thing standing between a fresh signup and a real email in
their own inbox is the four chores above. Remove all four for that first send,
and the funnel inverts: play first, paperwork once they are invested. DNS stops
being step one and becomes "before you send to real people", which is a sentence
a user will happily act on.

## What already exists (do not rebuild)

Worth reading before writing anything:

- `src/components/domain-setup-guide.tsx` (1253 lines) already does live polling
  with backoff, per-record DoH resolution checks, Cloudflare auto-DNS writes,
  per-record copy buttons, registrar doc links, and DMARC/Return-Path records in
  a collapsible. The DNS step is in good shape. A8 below only adds two things.
- `POST /api/audiences/[id]/subscribers/team` adds the whole org roster to an
  audience, suppression-aware and cap-aware, and enrolls them in live automations.
- `src/components/next-steps.tsx` is a one-line "next move" strip already dropped
  on the audiences and campaigns views. A6 promotes it rather than inventing one.
- `src/lib/campaign-templates.ts` plus `campaign-template-picker.tsx` supply ready
  layouts as pure data, deliberately unmetered and free-tier available.
- `/api/ai/draft` exists but is gated on `planHasAI`, so it is **not** available
  to the day-zero free user. Templates are the free-tier "this already looks
  good" moment. Do not plan the first-run experience around AI.
- The campaign detail page already has a live send banner, a 2.5s poll, and a
  celebration banner on completion. Plan B surfaces these, it does not build them.

## Workstreams

### A1. A shared Day3 sending domain for sandbox sends

The load-bearing change. Everything else is easier once this exists.

**Mechanism.** One SES domain identity, verified once on the AWS account, for a
dedicated subdomain (suggested: `sandbox.day3.app`). Never the apex and never the
domain transactional Day3 mail leaves from, so a reputation problem here cannot
reach anything that matters.

- New env: `SHARED_SANDBOX_DOMAIN`, `SHARED_SANDBOX_IDENTITY`. Unset means the
  feature is off, which keeps self-hosters and the test suite on the old path.
- New column `sending_domains.shared boolean not null default false`. Every
  consumer must be able to tell a Day3-owned row from a customer-owned one.
  Schema change, so `npm run db:generate` **and** `npm run db:migrate`.
- At account creation (`syncCurrentOrganization`, `src/services/accounts.ts`)
  insert one `sending_domains` row per account for the shared domain:
  `shared: true`, `verificationStatus: 'verified'`, `providerIdentityId` pointing
  at the shared identity, `fromEmail` derived from the org slug, `fromName` the
  org name. The existing `uq_sending_domains_account_domain` index makes this one
  row per account, which is what we want.

**The hard gate.** A shared-domain send must be a sandbox send, enforced in
`campaignSendGateError` (`src/api/campaigns.ts`) and in the automation and
transactional equivalents:

> If the resolved sending domain is `shared`, refuse any send that is not in
> sandbox mode.

Fail closed, in the service, never in a route handler (AGENTS.md hard rule 5).
The reasoning is the same as `planSandboxMode` deliberately not being
`!planCanSend`: the shared identity's reputation belongs to every tenant at once,
so an unrecognized state must lose its access to it rather than earn it. Sandbox
already bounds the blast radius to org members and 100 emails a month, and those
recipients are the only people on earth guaranteed to want the mail.

**Operator controls.** Add a per-account kill switch for the shared row on the
admin account page, and surface shared-domain volume and bounce counts on the
admin overview. The shared identity is the one piece of SES reputation no single
tenant owns, so an operator needs to see it and be able to cut one tenant off it
without touching anyone else.

**UI.** The shared row is not listed among customer domains on `/sending`. It
appears as its own card ("Your Day3 test address") that says plainly: works right
now, reaches your team only, verify your own domain to reach customers. In the
composer's sender dropdown it is clearly labelled and disabled for non-sandbox
accounts.

**Tests.** A non-sandbox account cannot send from a shared domain (service level,
not route level). A sandbox account can. The shared row never appears in the
customer domain list. Deleting a customer domain never touches the shared row.

### A2. Seed the team audience at account creation

So `hasSubscribers` is true from the first second and the sandbox path just works.

- Extract the body of `POST /api/audiences/[id]/subscribers/team` into
  `src/services/team-audience.ts`. Two front doors, one implementation, per the
  list-query rule in AGENTS.md.
- At account creation, create one audience and seed it with the org roster
  through that service.
- Idempotency without a new unique index: seed only when the account has zero
  audiences. Naturally re-runnable and it can never surprise an existing tenant.
- Add `audiences.seeded_team boolean not null default false` so
  `reconcileMembership` can add a teammate invited on day two into that audience
  and only that one. Schema change: generate and migrate.

**Tests.** Second call to the provisioning path is a no-op. An account that
already has an audience is not seeded. A new member lands in the seeded audience
and in no other.

### A3. The mailing address on shared-domain sends

**Decided 2026-09-18: use Day3's own address.** CAN-SPAM requires a physical
postal address in the footer, and `campaignSendGateError` refuses to send without
one. That was the last chore standing, and it is now removed for this one case.

On `sandbox.day3.app` Day3 is the sender of record and the recipients are the
org's own members, so Day3's registered postal address is the correct address to
publish, not a workaround. Customer domains are unaffected: the gate and the
account's own address keep applying there exactly as today.

**Implementation.** Do not branch at the five call sites. `companyAddress` is
passed into `renderCampaignEmail` from `src/services/campaign-send.ts`,
`src/queue/handlers/send-batch.ts`, `src/queue/handlers/automation-send.ts` and
`src/api/v1/campaigns.ts`, and five copies of this rule will drift. Add one
resolver:

```ts
// src/services/footer-address.ts
// Which postal address goes in the footer. Day3's own for shared-domain sends
// (we are the sender of record there); the account's for every customer domain.
export function footerAddress(
  account: { companyAddress: string | null },
  domain: { shared: boolean },
): string
```

Call it at each of those sites and nowhere else. Then:

- new env `DAY3_POSTAL_ADDRESS`, required whenever `SHARED_SANDBOX_DOMAIN` is set
  (validate the pair together in `src/lib/env.ts`, so a half-configured
  deployment fails at boot rather than in a footer),
- skip the address gate in `campaignSendGateError` only when the resolved domain
  is `shared`, alongside the sandbox check from A1.

**Tests.** A shared-domain send renders Day3's address and needs no account
address. A customer-domain send with no account address is still refused. The
resolver never returns an empty string when the shared env pair is set.

### A4. Two starting paths, not one

Today the checklist assumes a CSV exists. A new SaaS team with no list reads
"Import an audience" as a dead end, and that is most of the target market.

Ask one question on first visit and persist it (`accounts.onboarding_path`, null
or `has_list` or `building_list`; schema change):

- `has_list` keeps the CSV import step.
- `building_list` swaps it for "create a signup form", which the forms feature
  already serves end to end on `go.day3.app`.

The checklist step text and CTA follow from the stored answer. Nothing else
branches.

### A5. The day-zero dashboard is its own page

In `DashboardView`, branch on `!onboarding.hasSentCampaign` and render a
`FirstSendView` instead of the three tiles plus the recent-campaigns table. Not a
variant, a different composition:

1. **Hero: one button to a ready email.** Creates a draft from a template,
   addressed to the seeded team audience, on the shared domain, and drops the user
   into the composer with Send live. This is the whole page's job.
2. **The checklist, reordered around the new reality:** see your first email,
   then make it yours, then reach real people (domain), then grow the list.
3. **The preview strip** (A7).

Drop the three tiles here. "Free / 0 of 100 / Sandbox" answers no question a
user has in their first minute, and it occupies the position of most attention.

### A6. Carry progress across pages

`NextSteps` exists but is per-page, so a user doing DNS on `/sending` loses the
thread. Move it into `src/components/app-shell.tsx` as a slim strip above
`<main>`, rendered only while onboarding is incomplete, and drop the per-page
copies.

Feed it from the server: `app/(app)/layout.tsx` already resolves the account, and
`computeOnboardingState` is three pipelined reads on a `cache()`-memoized account.
Pass `OnboardingState` down as a prop. Do not add a mount fetch (AGENTS.md, page
data loading).

### A7. Show the payoff before it exists

Replace "No campaigns yet" with clearly labelled previews of the Plan B surfaces:
"after your first send you will see this here". Muted, locked, obviously an
example. **Never render invented numbers in a way a user could read as their own
data.** The label does the work, not the styling alone.

### A8. Two additions to the DNS step

The guide is already strong. Add only:

- **Registrar detection.** Resolve NS for the registrable root over the DoH path
  the `/check` route already uses, map the common nameserver suffixes to a
  registrar, and lead with that registrar's guide instead of a list of four.
- **`domain_verified` notification.** Add the kind to `NOTIFICATION_KINDS`
  (`src/db/schema.ts`) and emit it from `recheckPendingDomains` in
  `src/queue/cron.ts`, **inside** the guarded transition to verified so a
  re-check can never re-notify. Same discipline as the outbound webhook emissions
  described in AGENTS.md. This is what makes "paste the records and walk away" a
  promise the product actually keeps.

### A9. Never open a blank canvas

`/campaigns/new` opens the template picker immediately for an account with no
campaigns, rather than an empty composer. Blank editors are where non-technical
users stop. AI drafting stays exactly where it is, behind `planHasAI`.

### A10. Documentation

- `docs/onboarding-walkthrough.md` is stale: it lists "Activate your plan" as a
  step (there is no such gate) and points at `/domains` rather than `/sending`.
  Rewrite it against the new path.
- `PRODUCT.md`: the shared sandbox domain changes what the free tier *is*. Update
  §4 and bump "Last verified".
- `AGENTS.md`: add the shared-domain invariant beside the existing sandbox rules,
  in the same voice ("a shared-domain send must be a sandbox send, and the check
  fails closed").

## Sequencing

A1, A2 and A3 first, in that order: together they are what make day zero
chore-free, and every later item assumes them. A3's decision is already made, so
it ships with A1. Then A5 (the page that shows it off), A6, A9. A4, A7, A8 are independent and can
land in any order after. A10 ships in the same PR as whatever changed the product.

## Risks worth holding

- **Shared reputation is the real one.** The gate in A1 is the only thing between
  one careless tenant and every tenant's sandbox. It belongs in the service, it
  fails closed, and it gets a test that fails loudly.
- **Do not let the shared domain become a free sending tier.** 100 emails a month
  to your own teammates is a demo. If it ever reaches a stranger, the design has
  failed.
- Every schema change here (`sending_domains.shared`, `audiences.seeded_team`,
  `accounts.onboarding_path`) needs generate **and** migrate. Tests pass on pglite
  without the migrate step, so a forgotten one shows up only as a 500 in
  production.
