# Day3 — Product Source of Truth

> **What this file is.** The single, canonical description of Day3: what it is, who
> it's for, why it exists, how it works, and what it costs. It is written to be
> consumed by both humans and AI agents (website, marketing, SEO, support, sales).
> If something here conflicts with your assumptions, trust this file.
>
> **Keep it current.** This document MUST be updated whenever a feature, flow,
> price, limit, or integration changes. See [Maintaining this document](#maintaining-this-document).
>
> Last verified against the codebase: **2026-07-02**.

---

## 1. One-liner

**Simple product update emails for small SaaS teams. No marketing suite. No contact
tax. Set up and draft for free — pay only when you're ready to send.**

Day3 is a deliberately minimal newsletter/email tool for small software teams that
just want to send product updates and changelogs to their users — without learning,
paying for, or fighting a full marketing automation platform.

## 2. Positioning & philosophy

Day3 is opinionated and narrow on purpose. It does a few things well and refuses to
become a marketing suite.

- **For small SaaS teams**, not agencies or large marketing departments.
- **Product updates, not campaigns-in-the-marketing-sense.** Changelogs, release
  notes, "what's new" emails.
- **No contact tax.** You are not billed per subscriber. Pricing is bandwidth:
  you pick a monthly email allowance.
- **Free to build, paid to send.** A free account can set up domains, audiences,
  senders and draft campaigns (up to **500 subscribers**), but **cannot send** —
  sending is what a paid plan unlocks. Paid tiers differ only by monthly email
  allowance, with the **AI writing assistant** included on the **10k tier and up**.
- **Deliverability and compliance are built in, not add-ons:** verified sending
  domains, double opt-in, one-click unsubscribe, automatic bounce/complaint
  suppression, and account auto-pause on bad reputation.
- **Deliberately excluded:** marketing automation flows, audience segmentation,
  A/B testing, and drag-and-drop template builders. Open and click tracking plus a
  deliverability/reputation/engagement dashboard are included (see §6.10); the rest
  are out of scope by design.

## 3. Who it's for

Small SaaS teams (often a single founder or a tiny team) who need a reliable,
no-nonsense way to email their existing users about product changes, and who want
signup forms to grow that list — without the complexity or cost of Mailchimp,
HubSpot, ConvertKit, etc.

---

## 4. Pricing & tiers

Billing runs through **Clerk Billing** (Stripe-backed) and is scoped to the
**organization** (the tenant), not individual users. **Day3 sells sending
bandwidth:** a paid plan is a monthly email allowance at a price. The free tier is
set-up-only (no sending); the only feature gated by tier is the **AI assistant**
(10k and up).

| Plan | Clerk slug | Emails / month | Subscribers | AI assistant | Price |
|------|-----------|----------------|-------------|--------------|-------|
| **Free** | `free_org` | **0 — cannot send** | up to **500** | ❌ | **$0** |
| **1k** | `1k_plan` | **1,000** | unlimited | ❌ | **$1 / mo** |
| **5k** | `5k_plan` | **5,000** | unlimited | ❌ | **$3 / mo** |
| **10k** | `10k_plan` | **10,000** | unlimited | ✅ | **$5 / mo** |
| **25k** | `25k_plan` | **25,000** | unlimited | ✅ | **$12 / mo** |
| **50k** | `50k_plan` | **50,000** | unlimited | ✅ | **$24 / mo** |
| **100k** | `100k_plan` | **100,000** | unlimited | ✅ | **$49 / mo** |

Key pricing facts:

- **Every org starts on the always-active Free tier.** It can do everything except
  send: verify domains, add senders, import/collect subscribers, and draft
  campaigns. **Sending requires a paid plan** (from $1/mo).
- **The free tier is capped at 500 subscribers** (spam/abuse protection — a
  set-up-only account can't hoard a giant list). Paid tiers are unlimited. The cap
  is enforced on every insert path: manual add, CSV import, and public signup forms.
- **The AI writing assistant (draft / subjects / preview / rewrite) is gated to the
  10k tier and up.** Free/1k/5k accounts see an "upgrade to unlock AI" prompt; the
  AI routes return 403 for those tiers. AI usage on enabled tiers is still bounded
  by the per-org AI credit budget (rolling window + monthly backstop).
- **Each monthly allowance is a hard cap**, enforced atomically at send time so
  concurrent workers can never over-send. Sending hard-stops at the limit (no
  usage-based overages); the UI surfaces upgrade prompts as the cap approaches.
- **Usage resets** at the start of each billing period (driven by the Clerk
  `subscriptionItem.active` webhook; a monthly cron sweep is the fallback).
- **No per-contact / per-subscriber pricing.** Subscriber count does not affect price.
- **Subscription lifecycle → behavior:**
  - `active` → can send up to the plan's allowance.
  - `past_due` → plan still visible, but **sending is blocked** until payment is fixed.
  - `ended` → **gracefully downgrades to the Free tier** (still active, set-up +
    drafts), rather than locking the account out.
- **Risk-paused accounts never send**, regardless of plan, until an admin clears them.

> Source of truth in code: `src/lib/plans-catalog.ts` (plan catalog + send/AI/
> subscriber gating + upgrade-path helpers), `src/services/plans.ts` (send
> eligibility), `src/services/subscriber-limit.ts` (subscriber cap), the AI routes
> under `app/api/ai/**`, Clerk webhook `app/api/webhooks/clerk/route.ts`, billing UI
> `app/(app)/billing/page.tsx`. The plan keys above ARE the Clerk Billing plan slugs
> — they must match the plans configured in the Clerk dashboard. If you change
> pricing, plan slugs, limits, or gating, update this table.

---

## 5. Core concepts (domain model)

| Concept | What it is |
|---------|-----------|
| **Account** | The tenant. One per Clerk **organization**. Holds plan, usage, sending status, company mailing address, and a public `slug` for forms. |
| **Account user** | A team member (Clerk user) belonging to an account, with a role (`admin` / `member`). |
| **Audience** | A named list of subscribers. |
| **Subscriber** | A contact in an audience. Status: `subscribed`, `pending` (awaiting double opt-in), `unsubscribed`, `bounced`, `complained`, or `suppressed`. Only `subscribed` contacts receive campaigns. |
| **Sending domain** | A verified email-sending identity (e.g. `news.yourcompany.com`), set up via AWS SES with DKIM/SPF/DMARC DNS records. Campaigns require a verified domain. Adding one auto-creates its first **sender**. |
| **Sender** | A saved **From** identity — a from-name + from-address pair (e.g. `Jane from Acme <jane@news.acme.com>`) on a verified sending domain. Campaigns pick a sender instead of typing the From each time; an account can keep several per domain, with one marked default. |
| **Campaign** | A single email send to one audience. Lifecycle: `draft` → (optionally `scheduled`) → `pending_review` → `approved` → `generating_recipients` → `sending` → `sent` (or `paused`, `blocked`, `failed`). |
| **Campaign recipient** | A per-email send record — the source of truth for idempotent, no-duplicate delivery. Tracks delivery status (`pending`, `sending`, `sent`, `delivered`, `bounced`, `complained`, `unsubscribed`, `failed`, `skipped`). |
| **Form** | A hosted/embeddable signup form that captures new subscribers into an audience. |
| **Suppression entry** | A blocklist record (per-account or global) that prevents sending to an address that unsubscribed, bounced, complained, or was manually suppressed. |
| **Import** | A CSV upload job that adds subscribers to an audience. |
| **Risk review** | An automated spam/abuse assessment of a campaign before it sends. |

---

## 6. Features

### 6.1 Campaigns
- Create a campaign with name, subject, preview text, a **sender** (From), and an HTML
  body. The **name is an editable page title** at the top of the composer (falls back to
  the subject if left blank).
- **Email-style composer:** the settings (From, Reply-To, To/segment, Subject, Preview)
  read as the header rows at the top of a real email, with the body flowing directly
  beneath — one continuous message surface.
- **From is a sender picker:** the From row is a dropdown of the account's saved senders
  (the default / sole sender auto-selects), not free text. A new sender can be added
  inline without leaving the composer.
- **Reply-To (optional):** set a separate address for replies (e.g. `support@…`);
  defaults to the From address when left blank.
- **Autosave only (no Save button):** drafts save automatically a beat (~1s) after each
  edit, with a live "Saving… / Saved" indicator. Partial drafts are persisted from the
  first keystroke, so nothing is ever lost; everything a send needs is enforced at
  submit/schedule time instead. A brand-new draft is created on the first autosave and
  the URL switches to the campaign in place.
- **Section & column layout builder:** the body is a stack of **sections** that can be
  **added, removed, and drag-reordered**. Text, image, and button sections lay out as
  **1, 2, or 3 equal-width columns**, so you can mix a full-width intro with a two- or
  three-up row below it. Changing a section's column count never loses work (shrinking
  folds the extra columns into the last one). Sections serialize to email-safe layout
  tables, so multi-column layouts render in the inbox while staying within the allowlist.
  **Multi-column layouts are responsive:** on phones (and any client narrower than the
  ~600px body) two- and three-up columns, button rows, and side-by-side cards **collapse
  to a single stacked column**, with column images filling the new width — so the email
  reads cleanly on mobile without a separate layout. Desktop clients keep the side-by-side
  layout. A **brand-new campaign opens on a starter layout** (a text block plus a ready-made
  call-to-action button) rather than a blank canvas.
- **Section types** — chosen per section from a type menu, switchable at any time
  without losing work:
  - **Text** — rich content per column (see the WYSIWYG editor below), with a
    **left / center / right alignment** for the section's prose.
  - **Image** — one uploaded image per column that fills the column, with **alt text**,
    an optional **click-through link**, and a **drag-to-set height** (the image covers
    the box and is cropped to it for delivery so it isn't stretched). Uploads are
    PNG/JPEG/GIF/WebP up to 5 MB to managed public storage; on upload, oversized
    images are automatically downscaled (longest edge ≤ 1600px) and re-encoded
    (photos to JPEG, transparent images stay PNG) so the delivered email stays light
    for deliverability and load time.
  - **Button** — one call-to-action button per column (a "button row" for 2/3 columns),
    each with a label (edited directly on the button), link, **fill color** (from a
    palette), light/dark label color, row alignment, and a **width** choice
    (fit-to-label or full-width bar). Renders as a filled, bulletproof table button;
    an unfinished button (no link) never ships.
  - **Image + text (card)** — one image paired with rich text, laid out **image-left /
    image-right / image-on-top**.
  - **Quote / callout** — rich text in a **shaded, accent-bordered box** (background
    tint from a palette) with an optional attribution line.
  - **Divider** — a horizontal **rule**, or a blank **spacer** whose height you drag.
  - **Social links** — a centered (or left/right) row of links to the org's social
    profiles, with an optional lead-in ("Follow us:"). Rendered as text links.
  - **Per-section background** — any section can be given a **background color** (from a
    palette, or "no fill") that bleeds to the **full width** of the email, with the
    section's content padded inside the band; distinct from a quote's inset callout tint.
  - Buttons, callouts, and section backgrounds use a tightly-validated, **color-only**
    extension of the sanitizer allowlist (`bgcolor` on cells + `<font color>` for label
    text); no inline CSS, classes, or URLs can pass through, so the shared-reputation
    guarantees hold.
  - All section types are available on **every plan** — like all drafting, only
    *sending* is gated.
- **Global styling panel:** a dockable panel beside the message lets you style the
  whole email at once — **page background**, **content/section background**, **body,
  heading, and link colors**, a **border** (color + width), **image roundness**, and
  **section roundness**. The editing canvas re-themes live as you tune it (true
  WYSIWYG) and the inbox preview is byte-faithful to what ships. The theme is stored
  as structured, validated data (plain colors only; bounded sizes) and applied at
  **send time** in an email-safe document wrapper — it never touches the body
  allowlist, so the shared-reputation guarantees and "what you build is what ships"
  invariant both hold. A new campaign starts from a clean default look; **Reset**
  returns to it.
- **Rich-text WYSIWYG editor** (TipTap) — each text column is the same editor, constrained
  to an email-safe HTML allowlist, so what you see is exactly what recipients get.
  Formatting floats in on selection and a "+" insert menu appears on empty lines (no
  fixed toolbar). Insert options: headings, lists, and quotes.
- **Merge tags:** `{{first_name}}`, `{{last_name}}`, `{{email}}`, plus **any custom
  field** the audience collects (`{{company}}`, `{{phone}}`, …) — the insert menu lists
  the audience's own fields alongside the built-ins. Tags can carry a **fallback** for
  when the field is empty (`{{first_name|there}}` → "there", `{{plan|free}}`), so
  personalized copy never degrades to "Hi ,". Inserting "First name" from the toolbar
  drops in a fallback automatically.
- **Pre-send personalization check:** before sending, the campaign page warns when
  recipients in the chosen audience are missing a field the email uses (e.g. "312 of
  1,200 recipients have no first name — they'll see 'there'"), so a generic greeting
  to a large slice is a deliberate choice, not a surprise.
- **Footer:** shown in the message and editable — you control the wording (the
  "you're receiving this because…" line, which can use merge tags). The physical
  mailing address and the per-recipient one-click unsubscribe link are appended
  automatically at send time and can't be edited or removed (required by law; exactly
  one working link is guaranteed).
- **Send a test email** to yourself before sending for real.
- **Submit & send** kicks off a review → recipient-generation → batched-send pipeline.
- **Schedule for later:** pick a future date/time and the campaign parks in `scheduled`;
  a cron sweep releases it into the same review→send pipeline when due (granularity ~15
  min). Reschedule or cancel (back to `draft`) any time before it fires. If a send gate
  (verified domain, non-empty audience) has lapsed by release time, it returns to `draft`
  with a reason instead of sending.
- **Pause / resume** an in-flight send.
- **Duplicate a campaign** from the list's row actions menu — copies the content and
  settings (subject, body, audience, sender, from/reply-to, footer) into a fresh `draft`
  with a "Copy of …" name and a clean slate (no recipients, no risk review, never sent).
  Any campaign can be duplicated; the common case is re-running a campaign that sent well.
- **Delete a campaign** from the list's row actions menu or its detail page — removes the
  campaign and its recipient records (sent campaigns included). Blocked only while a send
  is actively in flight (`generating_recipients` / `sending`); pause it first.
- **Live delivery stats:** total recipients, sent, delivered, bounced, complained,
  unsubscribed, failed, skipped — plus a recipient-level table and an undeliverable list.
  (Account-wide and per-campaign rates, including opens, live on the Metrics page — §6.10.)
- **Risk review** runs before send; risky campaigns can be routed to admin review.

### 6.2 AI assist (optional)
AI features are **optional and gated** — if no AI key is configured, the AI UI is
hidden and the app works normally. Powered by **OpenRouter**, defaulting to
**Claude Sonnet 4.6** (`anthropic/claude-sonnet-4.6`, configurable).

- **Draft a full campaign** from a short brief → generates subject, preview text,
  and a complete **multi-section body** assembled from the builder's blocks — a
  heading, intro, dividers, the occasional callout/quote, a feature row of columns,
  and a single clear call-to-action button — not one flat text block. It drops
  straight into the section builder, ready to reorder, edit, or extend. (Image,
  card, and social blocks still need assets you add, so the draft leaves those to you.)
- **Subject line ideas** — generates 5 alternatives.
- **Preview text** — auto-writes an inbox preview from the subject + body.
- **Edit with AI** — highlight text in the editor and describe the change you want in
  a free-form prompt (e.g. "make this punchier and add a clear call to action"); the
  selection is rewritten to match.
- AI output is run through the same HTML sanitizer; merge tags are preserved.

**AI usage budget (per organization).** AI calls are metered against a shared,
per-org allowance so AI spend stays inside the plan's margin. A single quiet
usage meter (a percentage) lives in the sidebar, just above the organization
switcher — it's the only place the budget is shown. When the allowance is spent,
the meter shows a subtle "resets in Xh Ym", the composer's AI tools disable
themselves, and manual writing continues unaffected.

- The visible allowance is a **rolling 5-hour window** that resets automatically
  (anchored to first use), generous enough for a normal composing session.
- A **monthly ceiling** per org sits underneath as a silent backstop against
  runaway use; normal users never reach it.
- There is currently **no way to buy more** — the allowance simply replenishes on
  reset. Usage is measured from actual model tokens. All limits are
  configuration-tunable.

### 6.3 Audiences & subscribers
- Create, **rename**, and **delete** named audiences. Deleting an audience removes it and
  all its subscribers (sent campaigns are unaffected).
- **CSV import** (email, first_name, last_name, **plus any extra columns**, which become
  custom fields keyed by a slug of the header; up to ~5,000 rows per file) with dedup,
  suppression filtering, progress tracking, and re-upload/retry for failed imports.
  Column order is flexible and headers are alias-matched — only an `email` column is
  required — and a downloadable sample template shows the expected shape.
- **CSV export** of an audience's subscribers (all statuses) in the same column shape the
  importer reads, so an export can be edited and re-imported cleanly.
- **Custom fields:** beyond email/first/last name, a subscriber can carry any number of
  custom attributes (phone, company, …) collected by signup forms or CSV import. They
  show as columns in the subscriber list and are usable as `{{merge_tags}}` in campaigns.
- **Add subscribers manually**; **edit** a subscriber's email, name, and custom fields, or
  **delete** one outright (distinct from unsubscribe, which keeps the record but stops mailing).
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
- **AI prompt** — a one-click copyable prompt bundling the embed/HTML snippets and
  guardrails (don't rename fields, keep the action URL) that a user pastes into their
  own AI assistant (ChatGPT, Claude, Cursor…) to get the form onto their site.

Form configuration: headline, description, an optional **footer text** block, button
label, success message, optional post-signup redirect, active/off toggle, and a
**double opt-in** toggle. **Design** is tunable from the same panel — a clean,
Apple-inspired set of controls: page & card **background colors**, **heading** and
**body text** colors, **button (accent) color**, **corner roundness**, and an optional
**banner image** uploaded to the asset bucket and shown flush across the top of the
card. Colors are validated (hex/rgb/named only) and applied as inline styles at render
time, so the design carries across the hosted page, the iframe embed, and the popup
widget automatically (the raw-HTML snippet stays "restyle it yourself"). Defaults
reproduce the prior clean white-card look, so existing forms are unchanged until edited.
**Fields** are fully customizable — email is always collected, and you can add
any number of extra fields (first/last name, phone, company, anything) with a label,
type, and required flag; each becomes a personalization tag (e.g. `{{phone}}`) usable
in campaigns. A **live preview** updates as you edit, and the
form **autosaves** (no Save button): edits persist a beat (~1s) after each change, with
the same "Saving… / Saved" indicator as the campaign composer.

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

### 6.6 Senders (From identities)
- A **Senders** page manages the From name + address pairs campaigns send as. Each
  sender lives on a verified sending domain (its address must be at that domain).
- The From details entered when adding a domain become that domain's **first (default)
  sender** automatically; an account can keep several senders per domain and mark one
  default (the one the composer preselects).
- Add / edit / remove senders, or add one inline from the campaign composer. Removing a
  sender never affects campaigns already sent — each campaign snapshots its From at send.

### 6.7 Compliance & reputation
- **One-click unsubscribe** (RFC 8058 / `List-Unsubscribe`) with HMAC-signed tokens,
  plus a public unsubscribe page.
- **Mailing address required to send:** a campaign cannot be submitted or scheduled
  until the account has a company mailing address (it's rendered into every footer
  for CAN-SPAM); the send gate blocks it with an actionable message otherwise.
- **Automatic suppression** of bounced/complained/unsubscribed addresses (per-account
  and global scopes).
- **Bounce/complaint handling** via SES → SNS webhooks updates recipient status and
  suppresses bad addresses; sustained bad reputation **over a trailing window** can
  auto-pause an account (and pages on-call via the error sink).
- **Public Privacy Policy and Terms** pages (`/privacy`, `/terms`), linked from the
  marketing footer.

### 6.8 Billing & account settings
- Billing page: current plan, subscription status, monthly usage, renewal date, and
  a plan picker built as a bandwidth slider over a focus carousel. The user slides
  along the email-volume ladder ("how many emails per month?", free → 100k); the
  matching tier card snaps into focus in a horizontally scrolling row of all tiers
  (scaled up, neighbors dimmed), and scrolling the row moves the slider in sync. Only
  the focused card exposes the billing CTA, which drives Clerk Billing directly —
  upgrades/switches open Clerk Checkout, "Downgrade to Free" opens Clerk's
  subscription drawer to cancel (Clerk handles proration).
- Settings: company mailing address (legally required in email footers) and Clerk's
  organization management (team members, org name, logo).

### 6.9 Admin (staff only)
- Platform overview: account counts, campaigns by status, recent failed/dead-letter jobs.
- Per-account drill-down: pause/resume sending, usage, bounce/complaint rates, domains, campaigns.
- **Campaign review queue:** approve & send, or block (with reason) flagged campaigns.
- Force-verify a domain; suppress addresses globally.

### 6.10 Metrics (deliverability, reputation, engagement)
A dedicated **Metrics** page (in the main nav) aggregates sending performance across
all campaigns, with a filter to scope to a single campaign:
- **KPI tiles:** sent, delivered, opened, clicked, bounced, complained, unsubscribed.
- **Deliverability:** a sent → delivered → opened → clicked funnel with the delivery rate.
- **Reputation:** bounce-rate and complaint-rate gauges scaled to the provider's review
  thresholds (keep bounces under 5%, complaints under 0.1%), with a health status.
- **Engagement:** open rate, click rate, and unsubscribe rate, measured against delivered mail.
- **By campaign:** a sortable, searchable breakdown table of per-campaign rates.

**Open tracking:** every sent email carries a per-recipient, HMAC-signed 1×1 tracking
pixel served from `/api/track/open`. The first load stamps the recipient's `opened_at`
and records one `open` event; repeat loads are no-ops, so opens are counted once per
recipient. Privacy proxies (e.g. Apple Mail Privacy Protection) pre-load images, so open
rates can be overstated — surfaced as a caveat in the UI.

**Click tracking:** content links in the body are rewritten per recipient to redirect
through `/api/track/click`, which records the click and 302s to the destination. The
destination URL is HMAC-signed into the token (never read from a query param), so the
redirect can only ever land on a URL we issued — it cannot be turned into an open
redirect. Only absolute http(s) links are tracked; the unsubscribe link is never
rewritten. The first click stamps `clicked_at` (and back-fills `opened_at`, since a click
proves an open) and records one `click` event; repeat clicks are no-ops. Per-link
click breakdowns are not surfaced yet (the click event stores the URL for future use).

### 6.11 Activity (email event log)
A dedicated **Activity** page (in the main nav) lists every email event for the
account newest-first — sent, delivered, opened, clicked, bounced, marked as spam,
unsubscribed, failed, and provider errors — so users can check status and
troubleshoot ("did jane@example.com get the newsletter, and if not, why?"):
- **Filters:** by event type, by campaign, and a search box matching the recipient
  email (substring). Offset-paginated with "Load more".
- **Detail drawer:** clicking a row opens a side panel with a plain-language
  explanation of the event (e.g. permanent vs. temporary bounce, what suppression
  means), the recipient, time, a link to the campaign, the failure reason /
  clicked URL / bounce diagnostic where applicable, and the raw provider payload
  behind a collapsed "Technical details" section.
- Backed by the append-only `email_events` table (written by the send pipeline,
  the SES webhook, and the tracking endpoints); the page is read-only. The name
  "Activity" is deliberately broader than email so future sources (e.g. an API
  audit log) can slot in alongside without renaming.

### 6.12 In-app help
A **Help** button sits at the bottom of the sidebar on every page. It opens a small
popover with a single message box; sending relays the message to the support inbox
(`connect@day3.app`) with the signed-in user set as Reply-To, so the team can reply
straight back by email. The popover also links the same address directly for users who
prefer their own mail client. Available on every plan; there is no separate docs site yet.

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
1. **Submit** — user submits a campaign (now, or scheduled for later); it's validated
   (eligible account, verified domain, audience has subscribers) and moves to
   `pending_review`. A scheduled campaign waits in `scheduled` until a cron sweep
   re-checks the gates and releases it at its due time.
2. **Review** — an automated risk check approves it (or routes it to admin review /
   blocks it).
3. **Generate recipients** — eligible (`subscribed`, non-suppressed) subscribers are
   bulk-inserted as `campaign_recipients` (chunked, dedup-safe).
4. **Batched send** — the worker atomically reserves monthly quota, claims ~25 pending
   recipients at a time (`FOR UPDATE SKIP LOCKED`), renders + sends each via SES, and
   re-enqueues until done.
5. **Events** — SES delivery/bounce/complaint events flow back via SNS webhooks and
   update recipient status + suppression.
6. **Sweeps** — cron recovers stuck sends, re-checks pending domains, releases due
   scheduled campaigns, and reconciles campaign completion.

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
