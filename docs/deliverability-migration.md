# Deliverability onboarding & migration help (design doc)

**Status:** not started — design notes for future implementation.
**Priority:** should-have before actively courting customers migrating from other ESPs.

## Background: what prompted this

Our own first test send (July 2026, `updates.pradsgaardlabs.com`) authenticated
perfectly — SPF aligned via the custom Return-Path, DKIM pass, DMARC pass,
`compauth=pass` — and Outlook still junked it with `SCL: 5`. The cause was pure
cold-start reputation: a days-old subdomain with zero sending history, on SES
shared IPs, sending short test content. Gmail filed the same send under
Promotions (correct and fine); Microsoft is the strict one.

This will hit two kinds of Day3 customers:

1. **New senders** — fresh domain or subdomain, no history anywhere. They *will*
   see junk placement at Microsoft for the first weeks. Unavoidable; can only be
   managed (warm-up, engagement, expectations).
2. **Migrators from other ESPs** (Mailchimp, Brevo, …) — their *domain*
   reputation and per-recipient engagement history transfer with them; the IP
   reputation and the domain↔IP association do not (they move onto SES's shared
   pool). Migrators are usually fine **if** they (a) reuse the same sending
   subdomain they sent from before, and (b) bring their suppression list, not
   just their active list. The failure mode is minting a fresh subdomain and
   immediately blasting a stale import — that recreates the cold-start scenario
   with a worse list.

Authentication is already a non-issue: the domain-setup flow
([ses-identity.ts](../src/services/ses-identity.ts)) provisions Easy DKIM, a
custom Return-Path (`send.<domain>` MX + SPF, giving DMARC alignment), and a
recommended DMARC record, surfaced in
[domain-setup-guide.tsx](../src/components/domain-setup-guide.tsx). Everything
below builds on top of that baseline.

## Explicit non-goals

- **Dedicated SES IPs** — wrong trade at our customers' volumes; a dedicated IP
  makes warm-up *harder*. Revisit only for very large senders.
- **Microsoft SNDS / JMRP registration** — IP-based programs; on shared SES IPs
  that relationship belongs to Amazon, not us or the customer.
- **Inbox-placement seed testing** (Litmus-style) — out of MVP scope; a
  third-party integration at best, much later.
- **"Guaranteed inbox/Primary-tab placement"** — never promise this anywhere in
  UI or marketing copy. Promotions-tab placement in Gmail is *correct* for
  newsletters and not a problem to fix.

## Feature 1 — Migration guidance in the domain-setup flow

**Size: small (copy + one UI hint). Do this first; highest value per effort.**

When a user adds a sending domain, we currently say nothing about *which*
domain/subdomain to pick. Add guidance at the point of entry:

- In the add-domain step, before the DNS records are shown: a short callout —
  *"Coming from another email platform? Use the **same subdomain** you sent
  from there (e.g. `news.yourdomain.com`). Sending reputation is tracked per
  subdomain; reusing it carries your history over. A brand-new subdomain starts
  from zero with inbox providers."*
- After verification succeeds, set expectations for new subdomains: *"New
  sending domains typically see some spam-foldering (especially at
  Outlook/Microsoft) for the first 2–4 weeks while reputation builds. Start
  with your most engaged recipients and ramp up gradually."* Link to the
  onboarding doc (Feature 4).

Implementation: static copy in
[domain-setup-guide.tsx](../src/components/domain-setup-guide.tsx) (or the page
hosting it). No schema or API changes. Optionally detect "looks new" by probing
for an existing MX/TXT history — **don't**; not reliably detectable, keep it as
unconditional guidance.

## Feature 2 — Suppression-list import

**Size: medium. The most important *functional* gap for migrators.**

Every serious ESP lets you export your unsubscribes/bounces; migrators must be
able to bring them into Day3 so a past unsubscriber is never mailed again
(reputation + GDPR/compliance issue, not just deliverability polish).

Most of the machinery already exists:

- `suppression_entries` table with account/global scope and reasons
  `unsubscribe | hard_bounce | complaint | manual | provider_suppressed`
  ([schema.ts:488](../src/db/schema.ts#L488)), plus `addSuppression()` /
  `getSuppressedEmails()` in [suppression.ts](../src/services/suppression.ts).
- CSV import already filters suppressed emails on the way in
  ([process-import.ts:65-73](../src/queue/handlers/process-import.ts#L65-L73)),
  and `generate-recipients` only mails `status='subscribed'` rows.

What's missing is a **user-facing way to bulk-load suppressions**:

1. **New route** `POST /api/suppressions/import` accepting a one-column (or
   `email,reason`) CSV. Reuse the storage-upload + queue pattern from audience
   imports (`process_import`): store the object, insert an import row, enqueue.
   Small lists (< ~10k) could be processed inline, but reusing the async path
   keeps one code shape.
2. **New queue handler** (or a mode on `process_import`): parse, canonicalize
   via `canonicalizeEmail`, insert via `addSuppression` semantics in chunked
   multi-row inserts (`onConflictDoNothing`, chunked — 65535-param rule).
   Reason: map from the CSV column when present and valid, else `manual`.
   Consider adding an `imported` value to `SUPPRESSION_REASONS` so provenance
   is queryable (schema change ⇒ `db:generate` **and** `db:migrate`).
3. **UI**: a "Suppression list" section (Settings or Audience area) — upload
   CSV, view/search entries, add/remove single addresses. Use the shared
   [data-list.tsx](../src/components/ui/data-list.tsx) primitives.
4. **Migration nudge**: in the audience CSV-import flow, a callout — *"Coming
   from another platform? Import your unsubscribe/bounce list first, under
   Suppressions. Mailing people who unsubscribed elsewhere damages your
   sending reputation (and may be unlawful)."* Ordering matters: suppressions
   loaded **before** the subscriber import are filtered automatically by the
   existing import-time check.

Idempotency: suppression inserts are already `onConflictDoNothing`; a retried
job must not error on duplicates. All queries account-scoped as usual.

## Feature 3 — Domain warm-up ramping

**Size: large. Genuinely valuable, but weigh against MVP scope before starting.**

Cap daily send volume for *young* sending domains and ramp the cap up over
time, e.g. (tunable):

| Days since first send | Daily cap |
|---|---|
| 1–3 | 200 |
| 4–7 | 500 |
| 8–14 | 1,000 |
| 15–21 | 5,000 |
| 22+ | uncapped |

Design sketch:

- **Schema**: `sending_domains.first_send_at` (set on the domain's first
  successful campaign send) + `warmup_exempt boolean` (support/ops escape
  hatch, e.g. for a domain the customer demonstrably warmed elsewhere).
- **Enforcement point**: `send-batch` already handles "stop mid-campaign and
  resume later" for SES's own daily quota
  ([send-batch.ts:462-473](../src/queue/handlers/send-batch.ts#L462-L473)):
  unlock the unclaimed rest, `pauseCampaign(reason)`. Warm-up reuses that exact
  shape — before claiming, compute today's sent count for the domain (count
  `email_events` rows `eventType='sent'` for the account/domain since UTC
  midnight, or keep a Redis counter like the AI budget does) and claim
  `min(SEND_BATCH_SIZE, capRemaining)`. When remaining hits 0, pause with a
  user-comprehensible reason: *"Domain warm-up limit reached (500/day during
  week 1). Sending resumes automatically tomorrow."*
- **Auto-resume**: today `pauseCampaign` requires manual resume — fine for
  error pauses, wrong for warm-up (nobody should babysit a ramp). Add a cron
  sweep ([cron.ts](../src/queue/cron.ts)) that re-enqueues `send_batch` for
  campaigns paused with a warm-up reason once the UTC day rolls over. Mark
  warm-up pauses distinctly (e.g. `paused_reason` prefix or a dedicated column)
  so the sweep never auto-resumes campaigns paused for real errors.
- **UI**: show warm-up state on the domain page ("Day 5 of warm-up — current
  limit 500 emails/day") and on a paused campaign so the pause reads as a
  feature, not a failure. Composer pre-flight: warn when the selected audience
  exceeds today's remaining cap ("will send over N days").
- **Interaction with plans**: warm-up caps are orthogonal to plan bandwidth
  limits — apply whichever is lower. Keep gating logic in
  [plans-catalog.ts](../src/lib/plans-catalog.ts) untouched; warm-up is a
  domain property, not a plan property.

Open questions to settle at implementation time:

- Per-domain or per-account caps? Per-domain matches how providers track
  reputation; per-account is simpler. Lean per-domain.
- Should users be able to *opt out*? Recommend: no self-serve opt-out (the cap
  protects them and our shared-IP standing), `warmup_exempt` set by admins only.
- Does `first_send_at` start at domain verification or first real send? First
  real send — verification often happens days before content is ready.

## Feature 4 — "Getting into the inbox" onboarding doc + in-app pointers

**Size: small. Content work, mostly.**

A customer-facing help page (marketing site or in-app) covering, in plain
language for non-technical users:

- Why new domains land in spam/Promotions at first, and the realistic 2–4 week
  timeline. Gmail's Promotions tab is normal for newsletters, not a defect.
- Migrator checklist: reuse your sending subdomain; import your suppression
  list first; start with your most engaged segment; keep sending consistently.
- What Day3 already does for them (DKIM/SPF/DMARC alignment out of the box).
- Where to watch: the **Metrics** page (deliverability/reputation/engagement)
  and **Activity** page (per-email event log) — bounce/complaint spikes after a
  migration show up there. Complaint rate is the number to watch (keep well
  under 0.1%).
- What *not* to do: buy lists, mail old scraped addresses, remove the
  unsubscribe link, burst-send from day one.

In-app: link this doc from the domain-verified success state (Feature 1), the
import flow (Feature 2), and the Metrics page empty/early state.

## Suggested build order

1. Feature 1 (copy in domain setup) + Feature 4 (doc) — a day's work combined,
   prevents the worst mistakes before any new machinery exists.
2. Feature 2 (suppression import) — the real functional gap; unblocks serious
   migrators.
3. Feature 3 (warm-up ramping) — biggest lift; decide post-MVP whether demand
   justifies it. Until then, Feature 4's manual ramp guidance covers the need.

When any of these ship: they change what the product does — **update
`PRODUCT.md` in the same PR** per repo policy.
