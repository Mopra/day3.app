# Day3 — Product Source of Truth

> **What this file is.** The single, canonical description of Day3: what it is, who
> it's for, why it exists, how it works, and what it costs. It is written to be
> consumed by both humans and AI agents (website, marketing, SEO, support, sales).
> If something here conflicts with your assumptions, trust this file.
>
> **Keep it current.** This document MUST be updated whenever a feature, flow,
> price, limit, or integration changes. See [Maintaining this document](#maintaining-this-document).
>
> Last verified against the codebase: **2026-06-23**.

---

## 1. One-liner

**Simple product update emails for small SaaS teams. No marketing suite. No contact
tax. No free tier.**

Day3 is a deliberately minimal newsletter/email tool for small software teams that
just want to send product updates and changelogs to their users — without learning,
paying for, or fighting a full marketing automation platform.

## 2. Positioning & philosophy

Day3 is opinionated and narrow on purpose. It does a few things well and refuses to
become a marketing suite.

- **For small SaaS teams**, not agencies or large marketing departments.
- **Product updates, not campaigns-in-the-marketing-sense.** Changelogs, release
  notes, "what's new" emails.
- **No contact tax.** You are not billed per subscriber. Pricing is a flat plan.
- **No free tier.** Day3 is a paid product; there is no free plan and no perpetual
  trial. (This is a hard product rule.)
- **Deliverability and compliance are built in, not add-ons:** verified sending
  domains, double opt-in, one-click unsubscribe, automatic bounce/complaint
  suppression, and account auto-pause on bad reputation.
- **Deliberately excluded:** marketing automation flows, audience segmentation,
  A/B testing, drag-and-drop template builders, open/click analytics dashboards
  beyond basic delivery stats, and a free tier. These are out of scope by design.

## 3. Who it's for

Small SaaS teams (often a single founder or a tiny team) who need a reliable,
no-nonsense way to email their existing users about product changes, and who want
signup forms to grow that list — without the complexity or cost of Mailchimp,
HubSpot, ConvertKit, etc.

---

## 4. Pricing & tiers

Billing runs through **Clerk Billing** (Stripe-backed) and is scoped to the
**organization** (the tenant), not individual users.

| Plan | Clerk slug | Monthly email limit | Sending | Notes |
|------|-----------|---------------------|---------|-------|
| **None** | `none` | 0 | ❌ Disabled | Default state before subscribing, or after a subscription ends. |
| **Tiny** | `tiny` | **10,000 emails / month** | ✅ Enabled | The paid plan. Priced ~**$9/mo** (price is configured in the Clerk dashboard, not in code). |

Key pricing facts:

- **There is exactly one paid plan today (`tiny`).** No free tier, no annual
  option, no usage-based overages — sending hard-stops at the monthly limit.
- **The 10,000/month limit is a hard cap**, enforced atomically at send time so
  concurrent workers can never over-send.
- **Usage resets** at the start of each billing period (driven by the Clerk
  `subscriptionItem.active` webhook; a monthly cron sweep is the fallback).
- **No per-contact / per-subscriber pricing.** Subscriber count does not affect price.
- **Subscription lifecycle → behavior:**
  - `active` → can send.
  - `past_due` → plan still visible, but **sending is blocked** until payment is fixed.
  - `ended` → plan drops to `none`, sending disabled.
- **Risk-paused accounts never send**, regardless of plan, until an admin clears them.

> Source of truth in code: `src/services/plans.ts` (plan entitlements), Clerk
> webhook `app/api/webhooks/clerk/route.ts`, billing UI `app/(app)/billing/page.tsx`.
> If you change pricing, plan slugs, or limits, update this table.

---

## 5. Core concepts (domain model)

| Concept | What it is |
|---------|-----------|
| **Account** | The tenant. One per Clerk **organization**. Holds plan, usage, sending status, company mailing address, and a public `slug` for forms. |
| **Account user** | A team member (Clerk user) belonging to an account, with a role (`admin` / `member`). |
| **Audience** | A named list of subscribers. |
| **Subscriber** | A contact in an audience. Status: `subscribed`, `pending` (awaiting double opt-in), `unsubscribed`, `bounced`, `complained`, or `suppressed`. Only `subscribed` contacts receive campaigns. |
| **Sending domain** | A verified email-sending identity (e.g. `news@yourcompany.com`), set up via AWS SES with DKIM/SPF/DMARC DNS records. Campaigns require a verified domain. |
| **Campaign** | A single email send to one audience. Lifecycle: `draft` → `pending_review` → `approved` → `generating_recipients` → `sending` → `sent` (or `paused`, `blocked`, `failed`). |
| **Campaign recipient** | A per-email send record — the source of truth for idempotent, no-duplicate delivery. Tracks delivery status (`pending`, `sending`, `sent`, `delivered`, `bounced`, `complained`, `unsubscribed`, `failed`, `skipped`). |
| **Form** | A hosted/embeddable signup form that captures new subscribers into an audience. |
| **Suppression entry** | A blocklist record (per-account or global) that prevents sending to an address that unsubscribed, bounced, complained, or was manually suppressed. |
| **Import** | A CSV upload job that adds subscribers to an audience. |
| **Risk review** | An automated spam/abuse assessment of a campaign before it sends. |

---

## 6. Features

### 6.1 Campaigns
- Create a campaign with name, subject, preview text, from name/email, and an HTML body.
- **Rich-text WYSIWYG editor** (TipTap) constrained to an email-safe HTML allowlist —
  what you see is exactly what recipients get.
- **Merge tags:** `{{first_name}}`, `{{last_name}}`, `{{email}}`, plus an auto-appended
  unsubscribe footer and `{{company_address}}`.
- **Send a test email** to yourself before sending for real.
- **Submit & send** kicks off a review → recipient-generation → batched-send pipeline.
- **Pause / resume** an in-flight send.
- **Live delivery stats:** total recipients, sent, delivered, bounced, complained,
  unsubscribed, failed, skipped — plus a recipient-level table and an undeliverable list.
- **Risk review** runs before send; risky campaigns can be routed to admin review.

### 6.2 AI assist (optional)
AI features are **optional and gated** — if no AI key is configured, the AI UI is
hidden and the app works normally. Powered by **OpenRouter**, defaulting to
**Claude Sonnet 4.6** (`anthropic/claude-sonnet-4.6`, configurable).

- **Draft a full campaign** from a short brief + tone (friendly / professional /
  excited / casual / concise) → generates subject, preview text, and body.
- **Subject line ideas** — generates 5 alternatives.
- **Preview text** — auto-writes an inbox preview from the subject + body.
- **Select-to-rewrite** — highlight text in the editor and rewrite it (improve,
  shorten, friendlier, more professional, fix grammar).
- AI output is run through the same HTML sanitizer; merge tags are preserved.

### 6.3 Audiences & subscribers
- Create named audiences.
- **CSV import** (email, first_name, last_name; up to ~5,000 rows per file) with
  dedup, suppression filtering, progress tracking, and re-upload/retry for failed imports.
- **Add subscribers manually.**
- Search and filter subscribers by status; unsubscribe individuals.
- Subscriber-status breakdown per audience.

### 6.4 Signup forms
One form primitive, multiple install surfaces, all hosted on **`go.day3.app`**:

- **Hosted page** — a shareable link (`go.day3.app/<account>/<form>` pretty URL, or
  `go.day3.app/f/<id>` stable URL) for bios, emails, social.
- **Embed (iframe)** — drop-in snippet for website builders (Webflow, WordPress,
  Squarespace, etc.); auto-resizes via `postMessage`.
- **Popup** — JS widget (`embed.js`) triggered by button click, delay, exit-intent,
  or scroll depth.
- **Raw HTML** — a plain `<form>` that POSTs directly to Day3 (no JavaScript).

Form configuration: headline, description, button label, accent color, success
message, optional post-signup redirect, optional first-name collection, active/off
toggle, and a **double opt-in** toggle.

- **Double opt-in is ON by default** for deliverability. A pending signup is **never
  emailed a campaign** until it confirms via a signed confirmation link (token valid
  30 days). Double opt-in requires a verified sending domain (to send the confirmation).
- **GDPR:** consent IP is stored for form signups.
- Form submission is **idempotent** and **never resurrects** an opted-out/suppressed
  address.

### 6.5 Sending domains (deliverability)
- Add a domain and get the DKIM/SPF/DMARC DNS records to publish.
- **Auto-check / manual recheck** of verification status.
- Optional **Return-Path (custom MAIL FROM)** setup for better deliverability.
- **One-click DNS auto-configuration via Cloudflare OAuth** (connect a Cloudflare
  account; Day3 writes the records for you).

### 6.6 Compliance & reputation
- **One-click unsubscribe** (RFC 8058 / `List-Unsubscribe`) with HMAC-signed tokens,
  plus a public unsubscribe page.
- **Automatic suppression** of bounced/complained/unsubscribed addresses (per-account
  and global scopes).
- **Bounce/complaint handling** via SES → SNS webhooks updates recipient status and
  suppresses bad addresses; sustained bad reputation can auto-pause an account.

### 6.7 Billing & account settings
- Billing page: current plan, subscription status, monthly usage, renewal date, and
  Clerk's pricing table for upgrade/checkout.
- Settings: company mailing address (legally required in email footers) and Clerk's
  organization management (team members, org name, logo).

### 6.8 Admin (staff only)
- Platform overview: account counts, campaigns by status, recent failed/dead-letter jobs.
- Per-account drill-down: pause/resume sending, usage, bounce/complaint rates, domains, campaigns.
- **Campaign review queue:** approve & send, or block (with reason) flagged campaigns.
- Force-verify a domain; suppress addresses globally.

---

## 7. How it works (architecture)

Day3 is split into two cooperating tiers that share one Postgres database:

```
   Vercel (web)            Supabase Postgres            VPS Worker (BullMQ)
  ┌────────────┐          ┌────────────────┐          ┌──────────────────┐
  │ Next.js UI │  ──────► │  source of     │ ◄──────  │ queue consumer   │
  │ API routes │          │  truth (all    │          │ cron sweeps      │
  │ queue      │  ──┐     │  content + IDs)│          │ SES delivery     │
  │ producer   │    │     └────────────────┘          └──────────────────┘
  └────────────┘    │            ▲                            ▲
                    └──── Redis (BullMQ queue) ───────────────┘
```

- **Web tier (Vercel, Next.js 16 App Router):** serves the React 19 dashboard and the
  API route handlers. Enqueues jobs but runs no long-lived work or cron.
- **Worker tier (VPS, `worker/index.ts`):** the only consumer of the BullMQ queue.
  Drains the send queue and runs cron sweeps (every 15 min). Run under pm2/systemd/Docker.
- **Postgres (Supabase) is the single source of truth.** Queue messages carry IDs only,
  never content — the worker re-reads everything from Postgres.

### 7.1 The send pipeline
1. **Submit** — user submits a campaign; it's validated (eligible account, verified
   domain, audience has subscribers) and moves to `pending_review`.
2. **Review** — an automated risk check approves it (or routes it to admin review /
   blocks it).
3. **Generate recipients** — eligible (`subscribed`, non-suppressed) subscribers are
   bulk-inserted as `campaign_recipients` (chunked, dedup-safe).
4. **Batched send** — the worker atomically reserves monthly quota, claims ~25 pending
   recipients at a time (`FOR UPDATE SKIP LOCKED`), renders + sends each via SES, and
   re-enqueues until done.
5. **Events** — SES delivery/bounce/complaint events flow back via SNS webhooks and
   update recipient status + suppression.
6. **Sweeps** — cron recovers stuck sends, re-checks pending domains, and reconciles
   campaign completion.

### 7.2 Reliability rules (non-negotiable)
- **Idempotent jobs:** a retried message never duplicates a send. `campaign_recipients.status`
  is the source of truth; sends are claimed via atomic `UPDATE … LIMIT n`.
- **Every query is scoped by `account_id`**, resolved server-side from the Clerk org —
  client-provided account IDs are never trusted (admin routes excepted).
- **Stuck `sending` recipients are swept to `failed`, never back to `pending`** (resending
  could duplicate).
- **All email goes through the `EmailProvider` interface** — `mock` logs, `ses` sends.

---

## 8. Tech stack

| Layer | Technology |
|-------|-----------|
| Web framework | Next.js 16 (App Router) on Vercel |
| UI | React 19, Tailwind CSS 4, shadcn/ui (Base UI), react-hook-form, Zod |
| Rich-text editor | TipTap |
| Database | Postgres (Supabase) via Drizzle ORM (postgres.js driver) |
| Queue / jobs | BullMQ + Redis (ioredis), drained by the VPS worker |
| Email | AWS SES v2 (`@aws-sdk/client-sesv2`) + SNS for events |
| Auth / tenancy / billing | Clerk (Organizations = tenant boundary; Clerk Billing, beta) |
| File storage | Supabase Storage (CSV imports) |
| AI (optional) | OpenRouter (default Claude Sonnet 4.6) via the Vercel AI SDK |
| DNS automation | Cloudflare OAuth (optional, for auto-configuring SES records) |
| Testing | Vitest with pglite (in-memory Postgres per test) |

### External integrations & where they're configured
- **Clerk** — auth, organizations, billing; webhook at `/api/webhooks/clerk`.
- **AWS SES (region `eu-north-1` / Stockholm)** — sending + domain identity; events via
  **AWS SNS** → `/api/webhooks/ses`.
- **Supabase** — Postgres (source of truth) + Storage (CSV imports).
- **Redis (VPS, TLS)** — BullMQ queue + rate-limit cache.
- **OpenRouter** — optional AI assist.
- **Cloudflare** — optional OAuth DNS auto-configuration.

> Env validation lives in `src/lib/env.ts`; deployment steps in `docs/go-live.md`;
> health/observability in `docs/health-monitoring.md` (`GET /api/health`).

---

## 9. Key user flows

1. **Onboarding:** sign up → create/join an organization → subscribe to the `tiny` plan
   → verify a sending domain → create an audience → create a campaign → send.
2. **Grow the list:** create a signup form → embed/share it → subscribers confirm
   (double opt-in) → they land in an audience.
3. **Send a product update:** draft (optionally with AI) → test email → submit → Day3
   reviews, generates recipients, and sends in batches → watch live delivery stats.
4. **Stay compliant:** unsubscribes, bounces, and complaints auto-suppress; bad
   reputation can auto-pause the account.

---

## 10. Maintaining this document

**Rule: PRODUCT.md is the single source of truth and must be kept in sync with the
product.**

Whenever you (human or agent) ship a change that affects **what the product is or does**,
update this file in the **same change/PR**. That includes:

- New features, removed features, or changed behavior of existing features.
- Pricing, plan slugs, limits, or quota changes.
- New or removed integrations / external services.
- Changes to core flows (onboarding, sending pipeline, signup forms, compliance).
- Changes to the domain model (new entities, status values, etc.).

Do **not** record purely internal refactors, bug fixes, or implementation details that
don't change the product's behavior or positioning.

When you update it, also bump the "Last verified against the codebase" date at the top.

> This doc is intentionally consumable by downstream AI agents (website, marketing,
> SEO, support). Keep it accurate, concrete, and free of speculative/unbuilt claims —
> if something is planned but not shipped, label it clearly as such.
