# Deliverability hardening (design doc + implementation plan)

**Status (2026-08-17): not started.** Seven workstreams, all scoped below.

Sibling docs: [`deliverability-migration.md`](./deliverability-migration.md) (onboarding
and migration help, features 3 and 4 still open), [`health-monitoring.md`](./health-monitoring.md).

## Why this exists

A prospect asked, publicly, how Day3 isolates transactional from marketing mail during
spikes and how it handles bounces, complaints and suppression. The honest answer today is
good but has six specific holes. This doc closes them, plus one monitoring gap found while
auditing the answer.

Each workstream below is tagged with the public claim it backs, so it is unambiguous which
sentences are safe to say once a given piece ships.

| Claim | Needs |
|---|---|
| "Separate SES config sets per tenant" | W1 |
| "SES's own auto-pause underneath" | W1, W2 |
| "Transactional and marketing can't share a subdomain" | W3 |
| "Soft bounces suppress after four" | W5, W6 |
| "A breaker that stops seeing bounces can't read 0%" | W7 |

W4 backs no public claim. It is a genuine improvement that can be deprioritized.

Unchanged and already true, verified during the audit: SNS signature validation with a
non-AWS `SigningCertURL` refused, `TopicArn` allowlist and `SubscribeURL` host pin
([webhooks/ses/route.ts](../app/api/webhooks/ses/route.ts)); idempotency via
`uq_email_events_provider_message_event` plus guarded status transitions; suppression
re-checked at send time, not only at recipient generation
([send-batch.ts:431](../src/queue/handlers/send-batch.ts#L431)); RFC 8058 one-click
unsubscribe; app-level thresholds below SES's own review lines.

---

## W1. Per-tenant SES configuration sets

**Today.** One configuration set for the whole platform, from `SES_CONFIGURATION_SET`
([factory.ts:34](../src/email/factory.ts#L34)), baked into the single `SesEmailProvider`
instance the worker constructs ([worker/index.ts:88](../worker/index.ts#L88)). Consequence:
AWS measures one bounce rate for everything, so the only per-tenant reputation numbers that
exist are the ones Day3 counts itself. If the SNS feed breaks, there is no second source.

**Change.** One configuration set per account, provisioned on first domain add.

- **Schema**: `accounts.ses_configuration_set text` (nullable). Nullable is the rollout
  mechanism: null means "use the env default set", so every existing account keeps working
  and the change ships without a backfill on the critical path.
- Per *account*, not per domain: the tenant boundary is the account, one tenant with three
  domains wants one reputation view, and the SES quota (10,000 configuration sets per
  account) makes per-account viable far past any realistic customer count. Add an operator
  alert when the count crosses ~8,000 and fall back to the shared set beyond it.
- **Provisioning** (extend [ses-identity.ts](../src/services/ses-identity.ts), which already
  threads a `configurationSet` into `CreateEmailIdentityCommand` at
  [line 164](../src/services/ses-identity.ts#L164)):
  1. `CreateConfigurationSetCommand` with `ReputationOptions.ReputationMetricsEnabled: true`
     and `SendingOptions.SendingEnabled: true`.
  2. `CreateConfigurationSetEventDestinationCommand` pointing at the **existing**
     `SES_SNS_TOPIC_ARN`. Reusing the topic means the inbound webhook, its topic allowlist
     and its whole test suite stay untouched. Keep `MatchingEventTypes` to the three the
     webhook actually handles (`DELIVERY`, `BOUNCE`, `COMPLAINT`) unless the route's
     unknown-type fallthrough is verified to no-op first.
  3. `PutEmailIdentityConfigurationSetAttributesCommand` on the tenant's identities, so a
     send that forgets to name a set still lands on the tenant's set. Defense in depth.
- **Send path**: add `configurationSet?: string` to `SendEmailInput`
  ([provider.ts:1](../src/email/provider.ts#L1)); `SesEmailProvider.send` prefers
  `input.configurationSet` over `this.config.configurationSet`. Do **not** build a provider
  per tenant: that would multiply SES clients, break connection reuse, and put the tenant
  outside the `withSendPacing` wrapper that AGENTS.md makes load-bearing. The set travels
  with the message, the pacer stays singular.
- **Call sites** to pass `account.sesConfigurationSet`: [send-batch.ts](../src/queue/handlers/send-batch.ts),
  [send-transactional.ts](../src/queue/handlers/send-transactional.ts),
  [send-form-confirmation.ts](../src/queue/handlers/send-form-confirmation.ts),
  [notifications.ts](../src/services/notifications.ts), and the session test-send route.
- **Backfill**: a one-off script (or an idempotent cron pass) creating sets for accounts that
  already have a verified domain.
- **Teardown**: `DeleteConfigurationSetCommand` on account purge, alongside the existing
  best-effort `deleteIdentity` in [purge-account.ts](../src/queue/handlers/purge-account.ts).
  Same contract: idempotent, failures logged not fatal.

**Tests.** Mock provider records the configuration set it was handed; assert per-account
routing, assert the null-account fallback to the env default, assert purge deletes the set.

**Risk.** Low. Nullable column plus per-message override means partial rollout is safe at
every step.

---

## W2. SES-side auto-pause backstop

**Today.** [`enforceAccountHealth`](../src/services/health.ts) is the only thing that can stop
a bad sender. It runs on our numbers, from our webhook, in our code. A bug in any of the
three and nothing stops.

**Change.** A second breaker that uses SES's own reputation measurements and SES's own
sending switch, so it survives a bug in ours. Depends on W1 (no per-tenant metrics without
per-tenant sets).

Two shapes, in order of cost:

**2a (recommended first).** Extend the existing cron sweep ([cron.ts](../src/queue/cron.ts))
with a CloudWatch `GetMetricData` pass over the tenant configuration sets, reading
`Reputation.BounceRate` and `Reputation.ComplaintRate` in the `AWS/SES` namespace. Over a
threshold, call `PutConfigurationSetSendingOptionsCommand({ SendingEnabled: false })` and
route through the same pause path `enforceAccountHealth` uses, so the exactly-once
notification and the ops page fire once. Adds `@aws-sdk/client-cloudwatch`. No new webhook,
no per-tenant alarms, no per-alarm cost. Detection latency is one sweep (15 minutes).

**2b (upgrade, if latency matters).** A CloudWatch alarm per configuration set with an SNS
action, an `app/api/webhooks/ses-alarm` route reusing the same validator plus host allowlist
plus a `SES_ALARM_SNS_TOPIC_ARN` allowlist, same handler as 2a. Near-real-time, at roughly
$0.10 per alarm per month per tenant.

**Thresholds** sit *above* the app-level ones (say 4.5% bounce, 0.1% complaint) so the app's
own breaker normally fires first and this only catches the case where our pipeline is broken.

**Why the claim holds either way**: the metrics are SES's, and the kill switch is SES's
(`SendingEnabled: false` on the configuration set). Polling versus alarms changes latency,
not who is enforcing.

**Verify at implementation time**: the exact per-configuration-set metric dimension name
(expected `ses:configuration-set`) against current SES docs before writing the query.

---

## W3. Transactional and marketing cannot share a subdomain

**Today.** Nothing distinguishes the two. A tenant can point campaigns and
`POST /v1/emails` at the same sender, which means one bad campaign can junk their password
resets. Best practice is that the two never share a scored subdomain.

**Change.** Mark the *domain*, not the sender: the subdomain is what inbox providers score,
and senders inherit from it.

- **Schema**: `sending_domains.stream text not null default 'marketing'`, values
  `marketing | transactional`. Existing rows default to `marketing`, so campaigns keep
  working on day one.
- **Enforcement**: campaign sends require a sender whose domain is `marketing`;
  `POST /v1/emails` requires `transactional`. Gate in
  [campaign-send.ts](../src/services/campaign-send.ts) and the transactional accept path, per
  the AGENTS.md rule that gates live in the service and never in a route handler.
- **UI**: stream picker in the add-domain flow, the label on the domains list and the sender
  dropdown, and copy explaining why two subdomains beat one.

**Rollout is the hard part here, not the code.** Hard enforcement on day one breaks every
existing tenant that sends both ways off one domain. Phase it:

1. Ship the column, the UI and the enforcement for domains created *after* the flag date.
2. Warn (in app and in the API response) for existing tenants that violate it, with a
   one-click "add a transactional subdomain" flow.
3. Flip to hard enforcement for everyone on a published date.

Only after step 3 is "I don't let them share a subdomain" literally true. Until then the
honest phrasing is "new domains are separated, existing ones are being migrated".

**Product-affecting**: update `PRODUCT.md` in the same PR.

---

## W4. Enforcement floor for new accounts

**Today.** `MIN_ATTEMPTED_FOR_ENFORCEMENT = 50`
([health.ts:13](../src/services/health.ts#L13)) means every account gets 49 sends with no
enforcement at all. Largely mitigated by the free tier being sandbox-only, so mailing
strangers requires a paid plan, but the paid floor is $1.

**Change**, all inside [health.ts](../src/services/health.ts):

- Keep the rate floor, add an absolute trigger: pause at `bounced >= 10` or
  `complained >= 3` regardless of `attempted`. A 40% bounce rate over 25 sends is real damage
  and currently invisible.
- Lower the floor to 20 for accounts whose first send was under 7 days ago.

**Tests.** Cheap and self-contained: existing health tests plus cases for the absolute
trigger and the new-sender floor.

---

## W5. Soft-bounce accumulation

**Today.** Transient bounces are recorded and never suppress
([route.ts:190](../app/api/webhooks/ses/route.ts#L190)), so a permanently full or abandoned
mailbox is retried on every send forever. Industry norm is to suppress after three to five
consecutive soft bounces.

**Change.**

- **Schema**: new table `address_bounce_state` (`account_id`, `email`,
  `consecutive_soft_bounces`, `last_soft_bounce_at`, `updated_at`), unique on
  `(account_id, email)`. A counter table rather than a derived query: the webhook is the hot
  path and counting `email_events` per address per notification does not scale.
- **Webhook**: on a transient bounce, upsert with `consecutive_soft_bounces + 1`; at 4, call
  `addSuppression` with a new reason. On a `delivery` event for that address, reset to 0.
  The reset is the part that makes this correct rather than merely strict.
- **New suppression reason** `repeated_soft_bounce`, added to `SUPPRESSION_REASONS`
  ([schema.ts:777](../src/db/schema.ts#L777)). `reason` is a plain text column with no DB
  check constraint, so this is additive. Touch the reason label lists in
  [serialize.ts](../src/api/v1/serialize.ts), the Suppressions page filter, and
  [webhook-events.ts](../src/services/webhook-events.ts).
- **Deliberately NOT added to `TRANSACTIONAL_SUPPRESSION_REASONS`**
  ([transactional.ts:10](../src/services/transactional.ts#L10)). A full mailbox is a
  deliverability signal, not a rejection of the relationship, so it should still get a
  password reset. Same reasoning that keeps `unsubscribe` out of that list.
- **Housekeeping**: prune zero-count and long-stale rows in the daily cron.

**Threshold: 4.** The public answer says four. Match it, or change both.

---

## W6. Reclassify `Undetermined` bounces

**Today.** `Undetermined` is treated as a hard bounce and suppresses immediately, in both the
campaign and transactional branches of the webhook
([route.ts:194](../app/api/webhooks/ses/route.ts#L194),
[route.ts:341](../app/api/webhooks/ses/route.ts#L341)). That is stricter than the norm and
permanently drops some deliverable addresses.

**Change.** Route `Undetermined` into the W5 accumulator instead of the hard-failure path.
Ships with W5 or immediately after, never before: without the accumulator this would just be
a loosening.

**Tests.** Existing assertions that `Undetermined` suppresses on first sight must be updated
to expect accumulate-then-suppress. Expect this to be the only behavioral regression in the
whole plan, so make the test change deliberate and reviewed rather than mechanical.

---

## W7. Event-feed freshness

**Today.** [`checkHealth`](../src/lib/health.ts) covers DB, cron freshness and the worker
heartbeat. Nothing watches the SES event feed. If the SNS subscription lapses or the
configuration set stops publishing, no bounce rows arrive, the breaker computes 0% and every
dashboard reads perfectly healthy while reputation burns. This is the highest
risk-per-line-of-code item in the doc.

**Change.**

- Add an `events` sub-check to `HealthReport` and `checkHealth`: if there were sends in the
  last 30 minutes (`campaign_recipients.sent_at` or `transactional_emails.sent_at`) and no
  `email_events` row newer than 20 minutes, report `degraded`. Sends-gated on purpose, so a
  quiet night is not an alert.
- Respect the constraints already documented in that module: bounded with `withDeadline`,
  and generic constant `detail` strings only, since the endpoint is public.
- **Index**: add `idx_email_events_created_at` on `created_at`. The existing
  `idx_email_events_account_created` is account-scoped and cannot serve a global `max()`, so
  without this the probe degrades into a scan on the largest table in the schema.
- Also alert from the cron sweep via `logger.reportError`, not only in the probe body. A
  degraded sub-check nobody is paging on is not a backstop.

---

## Build order

1. **W7** (event freshness). Smallest change, protects every other guard. Do it first.
2. **W5 + W6** (soft-bounce accumulation, then `Undetermined`). One migration, one webhook
   change, one deliberate test update.
3. **W4** (enforcement floor). Hours, no schema.
4. **W1** (per-tenant configuration sets). The big one, but nullable-column safe at each step.
5. **W2a** (CloudWatch poll in cron). Needs W1.
6. **W3** (stream separation). Last, because the phased rollout is calendar-bound rather than
   engineering-bound.

The public answer becomes fully true at the end of step 6 (specifically after W3's phase 3).
After step 5, everything in it is true except the subdomain claim, which should be softened
to "new domains are separated" until then.

## Repo rules that apply

- Three schema changes (W1, W3, W5) plus one index (W7): each needs `npm run db:generate`
  **and** `npm run db:migrate` in the same change. Tests pass without the migrate step
  because pglite applies `migrations/` itself, so a forgotten migrate only shows up as
  every-query-500s at runtime.
- W1, W3 and W5 change what the product does: update `PRODUCT.md` and bump its
  "Last verified" date in the same PR.
- W3's gates go in the services (`campaign-send.ts`, the transactional accept path), never in
  a route handler. Two front doors, one implementation.
- W2's new inbound route, if 2b is chosen, is an SNS endpoint and inherits the full existing
  hardening set: signature validation, topic allowlist, host allowlist, body cap.
