# Onboarding walkthrough (sign-up to first campaign)

The guided path a new account takes, and the manual checks for each state.
Implements `docs/dashboard-day-zero-plan.md` (Plan A).

**The shape of it: the first email arrives before any setup.** A brand new org
used to face four chores before a single email could leave (a postal address, a
DNS-verified domain, an audience, and teammates in that audience), with "publish
these DNS records" as step one. Provisioning removes all four for the first send,
so the order is now: see it work, then make it yours, then reach real people.

## What every new account is given

Both run in `syncCurrentOrganization` (`src/services/accounts.ts`), best-effort
and idempotent, so an account created before the feature existed picks them up on
its next sign-in.

1. **A shared Day3 sending domain** (`src/services/shared-domain.ts`): one
   pre-verified row pointing at an SES identity we own, plus a matching sender so
   it is simply an option in every From dropdown. Governed by one rule: a
   shared-domain send must be a sandbox send, checked in `campaignSendGateError`
   and its automation/transactional siblings, failing closed.
2. **A team audience** (`src/services/team-audience.ts`): one audience seeded
   with the org's own members, so `hasSubscribers` is true from the first second
   and the sandbox path works with nothing imported. Only seeded when the account
   has no audiences at all.

Unset `SHARED_SANDBOX_DOMAIN` turns both off and the account starts on the old
verify-first path. `DAY3_POSTAL_ADDRESS` is required alongside it (`src/lib/env.ts`).

## Turning it on

1. **Pick a dedicated subdomain you own**, e.g. `sandbox.day3.app`. Not the apex,
   and not the domain your own transactional mail leaves from: a reputation
   problem on this identity reaches every tenant using it, so keep the blast
   radius off anything that matters.
2. **Create the SES identity and get the DNS records:**
   ```
   SHARED_SANDBOX_DOMAIN=sandbox.day3.app    DAY3_POSTAL_ADDRESS="Day3 ApS, ..."    npm run sending:setup-shared-domain
   ```
   It needs `AWS_REGION` and picks up `SES_CONFIGURATION_SET` so the identity is
   attached to the same event pipeline as customer domains (open/click/bounce
   tracking depends on it). Idempotent: re-run it to check progress.
3. **Publish the records it prints** in that zone. The DKIM CNAMEs are required;
   the Return-Path MX/SPF and DMARC are deliverability polish and worth doing.
4. **Re-run the script until it reports `verified`.** SES polls for the DKIM
   CNAMEs for 72 hours after the identity is created.

   On Cloudflare: there is no record for `sandbox.day3.app` itself. Add the
   records *under* it, into the existing `day3.app` zone, and set every CNAME to
   **DNS only (grey cloud)**. Cloudflare proxies new CNAMEs by default, and a
   proxied DKIM record answers with Cloudflare's IPs instead of the Amazon
   target, so SES never verifies. This is the single most common way this step
   stalls.
5. **Set both variables on the web tier and the worker**, then deploy:
   ```
   SHARED_SANDBOX_DOMAIN=sandbox.day3.app
   DAY3_POSTAL_ADDRESS=Day3 ApS, 1 Example Way, 1234 Copenhagen, Denmark
   ```
   Both tiers need them: the worker renders the footer on every send, and
   `validateEnv` refuses to boot with the domain set and the address missing.
6. **Nothing to backfill.** Existing accounts provision the shared domain and the
   team audience on their next sign-in, because both `ensure*` helpers are
   idempotent and run from `syncCurrentOrganization`.

To check it worked: sign in with a fresh org and confirm the dashboard offers
**Write my first email**, and that `/sending` shows the "Your Day3 test address"
card above an empty domain list. To turn it off again, unset
`SHARED_SANDBOX_DOMAIN`; provisioned rows stay but the day-one path closes.

## Flow

1. **Sign up / sign in.** Unauthenticated users hitting any `/(app)` route are
   redirected to `/sign-in` by `app/(app)/layout.tsx` (server-side).
2. **No active org → org picker.** A signed-in user without an active Clerk org
   is redirected to `/select-org` (Clerk `OrganizationList`), never a raw 403.
3. **Day-zero dashboard.** `/dashboard` renders `<FirstSendView>` instead of the
   usual tiles and campaign table while `!onboarding.hasSentCampaign`. Its job is
   one action: **Write my first email**, which calls `POST /api/campaigns/first`
   to create a draft from a template, addressed to the team audience, on the
   shared domain, and lands the user in the composer with Send live.
4. **The three steps**, in the order they now matter:
   - Send yourself the first one → the hero above
   - Send from your own address → `/sending`
   - Bring your subscribers in → `/audiences` (or `/forms`, see below)
5. **One question, after the first send.** "Do you already have a list?" writes
   `accounts.onboarding_path` via `POST /api/account/onboarding/path`. `has_list`
   keeps the CSV import step; `building_list` swaps it for a signup form, because
   "Import an audience" is a dead end for a team with nobody to import.
6. **The strip follows them.** `<NextSteps>` lives in `<AppShell>` now, fed by the
   layout's `computeOnboardingState`, so someone part-way through DNS on
   `/sending` still sees what is left. It hides itself on `/dashboard` (which has
   the full checklist) and on the page that fixes the step it points at.
7. **Send-blocking conditions stay actionable.** `sendBlockedReason` skips the
   mailing-address and verified-domain steps while the day-one path is open, since
   neither is required on the shared domain, and names them the moment it is not.

## The DNS step

`src/components/domain-setup-guide.tsx` already polls with backoff, resolves each
record over DoH, writes records for Cloudflare-connected accounts, and offers
per-record copy. Two additions make it a step you can walk away from:

- **Registrar detection** (`src/services/dns-registrar.ts`): the nameservers say
  who hosts the zone, so the guide leads with that provider's instructions rather
  than a list of four. Advisory only; an unknown NS falls back to the list.
- **`domain_verified` notification**: emitted from `recheckPendingDomains`
  (`src/queue/cron.ts`) inside the claimed status transition, so it fires exactly
  once. Without it, "paste the records and walk away" was not a promise the
  product kept.

## Manual checks (states)

Run `npm run dev` and exercise:

| State | How to reproduce | Expected UI |
|-------|------------------|-------------|
| No session | Open `/dashboard` signed out | Redirect to `/sign-in` |
| No org | Sign in, leave/destroy org | Redirect to `/select-org` |
| Brand new org | Fresh Clerk org, `SHARED_SANDBOX_DOMAIN` set | `<FirstSendView>`: hero with "Write my first email", 3-step list, locked payoff preview |
| Shared domain unconfigured | Unset `SHARED_SANDBOX_DOMAIN` | Hero replaced by "Set up your sending domain" pointing at `/sending` |
| First send done | Send the starter campaign | Hero gone, "Do you already have a list?" appears once |
| Path chosen | Answer the question | Audience step text/CTA follows the answer; question does not return |
| Mid-setup on another page | Go to `/audiences` before sending | Setup strip at the top of the page content |
| On the page a step fixes | Go to `/sending` while domain is the next step | Strip hidden (no self-reference) |
| Paid account, shared domain | Try to send a non-sandbox campaign on it | Refused: "only sends to your own team" |
| Operator cut-off | `POST /api/admin/accounts/{id}/shared-domain {disabled:true}` | Sending refused; admin row shows "cut off" |
| Domain verifies | Flip a pending domain in SES | `domain_verified` notification in the bell, once |
| Account paused | `riskStatus = paused` | Destructive alert; day-one path closed |
| Fully set up | Verified domain + own subscribers + sent | Normal dashboard, strip gone |

## Tests

`test/shared-domain.test.ts` covers the gate (including fail-closed on a
non-boolean sandbox flag), the address carve-out, provisioning idempotency, and
the onboarding-state derivations. `test/domain-recheck.test.ts` covers the
exactly-once `domain_verified` notification, `test/dns-registrar.test.ts` the
nameserver matching, and `test/env.test.ts` the env pairing on both tiers.
