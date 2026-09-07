# Sending infrastructure roadmap (deferred, trigger-based)

**Decision (2026-09-07): the current SES setup is sufficient at today's scale.** A handful
of users, three paying. Nothing below is a correctness problem; every item is a scaling or
multi-tenant-isolation concern. This doc records what to do and, more importantly, *when*,
so the decision does not have to be re-derived when the app grows.

Sibling docs hold the designs. This one only holds the triggers and the order:
[`deliverability-hardening.md`](./deliverability-hardening.md) (W1 to W7),
[`deliverability-migration.md`](./deliverability-migration.md) (features 1 to 4),
[`health-monitoring.md`](./health-monitoring.md).

## Where we stand

Going direct to SES rather than through Resend/Postmark is the standard choice for a
bandwidth-priced newsletter product (SES is roughly 10x to 40x cheaper per email, and the
plan ladder in `src/lib/plans-catalog.ts` does not have the margin to resell a wrapper).
The cost is that we own the deliverability engineering a wrapper would do for us.

Already at or above the industry median, verified 2026-09-07:

- Duplicate-safe sending: `maxAttempts: 1` on the SES client, retry classification in
  [`mapSesError`](../src/email/ses.ts) so only provably-unsent errors retry, atomic claim on
  `campaign_recipients` as the ledger.
- Redis GCRA pacer wrapped at the provider, reading `MaxSendRate` live
  ([`send-rate.ts`](../src/email/send-rate.ts)).
- Custom MAIL FROM, 2048-bit DKIM, DMARC guidance in domain setup
  ([`ses-identity.ts`](../src/services/ses-identity.ts)).
- SNS ingest with signature validation, cert-URL pin and topic allowlist
  ([`webhooks/ses/route.ts`](../app/api/webhooks/ses/route.ts)); idempotent event insert.
- RFC 8058 one-click unsubscribe; suppression re-checked at send time; app-level
  bounce/complaint breaker set below SES's own review thresholds.

Behind the median: all tenants share one SES configuration set (one reputation for
everyone), transactional and marketing share that reputation, soft bounces never
accumulate, no warm-up ramp, no dedicated IPs, no external inbox-placement signal.

## Triggers

Pick up an item when its trigger fires, not before. Items are listed in the order they
should land if several fire at once.

| # | Item | Trigger | Design | Size |
|---|---|---|---|---|
| 1 | Event-feed freshness check (W7) | The one item worth pulling forward at any scale: if the SNS subscription lapses, bounces stop arriving and every dashboard reads 0% while reputation burns. Do it the next time anyone touches `checkHealth`. | hardening W7 | Small, one index |
| 2 | Soft-bounce accumulation + `Undetermined` reclassification (W5, W6) | First support question of the form "why does this address keep bouncing" or "why was this address suppressed", or 20+ paying accounts, whichever first. | hardening W5, W6 | Medium, one migration |
| 3 | Enforcement floor for new accounts (W4) | Alongside #2. | hardening W4 | Small |
| 4 | Per-tenant reputation isolation (W1) | First paying customer whose list we did not vet by hand, or self-serve signups open, or 10+ paying accounts, or any single account's bounce rate crosses 1% in the SES console. **Before building the hand-rolled config-set-per-account design, check whether SES v2 tenant management (`CreateTenant`, per-tenant reputation and sending pause) is available in `eu-central-1`. If it is, prefer it over W1 as written.** | hardening W1 | Large |
| 5 | SES-side auto-pause backstop (W2a) | Immediately after #4; it depends on per-tenant metrics. | hardening W2 | Medium |
| 6 | Transactional vs marketing stream separation (W3) | First account sending transactional mail through the v1 API at meaningful volume (hundreds/day), or a prospect asks the isolation question again. | hardening W3 | Large, calendar-bound rollout |
| 7 | Domain warm-up ramp | First migrator arriving from another ESP on a fresh subdomain, or a second new domain gets junked by Outlook in its first weeks (our own first test send already did). | migration F3 | Large |
| 8 | Dedicated IPs (SES managed) | First account on `250k_plan` or above, or a customer asks. Below that, shared SES IPs are the better choice: a cold dedicated IP is worse than a warm shared pool. | none yet | Medium, mostly ops |
| 9 | External inbox-placement signal | Customers ask "why are my Gmail opens low" more than once. Surface Google Postmaster Tools domain data, or a seed-list placement test, on the metrics page. Product feature, not infra. | none yet | Medium |

## What to watch in the meantime

No code, a few minutes a month, until #1 and #4 exist:

- SES console, Reputation dashboard: account-level bounce rate under 5%, complaint rate
  under 0.1%. AWS pauses the whole account above those, and today that means every tenant.
- SES console, Account dashboard: the 24-hour quota and `MaxSendRate` still fit the
  largest active plan. `GetAccount` is what the pacer reads, so a raise applies itself.
- SNS subscription on the event topic still `Confirmed`. Until #1 ships, this is the only
  way to notice the feed is dead.
- `GET /api/health` still green (DB, cron freshness, worker heartbeat).

## Explicit non-goals

- **Running our own MTA.** Not at any scale this plan covers. SES's shared pool and
  reputation handling are the product; re-implementing them is a different company.
- **Moving to Resend, Postmark or similar.** The `EmailProvider` interface keeps this
  possible, and that optionality is worth keeping, but the unit economics rule it out as a
  default. Revisit only if SES becomes unavailable to us.
- **BIMI, ARC.** Nice on a checklist, no measurable effect at newsletter volumes.

## Repo rules that apply

Every item that adds a column needs `npm run db:generate` **and** `npm run db:migrate` in the
same change. #4, #6, #2 change product behavior and need a `PRODUCT.md` update. Any new gate
goes in a service (`campaign-send.ts`, the transactional accept path), never a route handler.
