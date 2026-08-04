# Day3 — Product Source of Truth

> **What this file is.** The single, canonical description of Day3: what it is, who
> it's for, why it exists, how it works, and what it costs. It is written to be
> consumed by both humans and AI agents (website, marketing, SEO, support, sales).
> If something here conflicts with your assumptions, trust this file.
>
> **Keep it current.** This document MUST be updated whenever a feature, flow,
> price, limit, or integration changes. See [Maintaining this document](#maintaining-this-document).
>
> Last verified against the codebase: **2026-08-04**.

---

## 1. One-liner

**Simple product update emails for small SaaS teams. No marketing suite. No contact
tax. Set up and draft for free — pay only when you're ready to send.**

Day3 is a deliberately minimal email tool for small software teams: send product
updates and changelogs to your users (newsletters/campaigns), and send your app's
**transactional email** — password resets, receipts, magic links — through one
Resend-style API call (§6.15). One domain setup, one allowance, one place to see
delivery — without learning, paying for, or fighting a full marketing automation
platform.

## 2. Positioning & philosophy

Day3 is opinionated: simple to use, honest about pricing, and built so the
default path is the deliverable one.

- **For small SaaS teams**, not agencies or large marketing departments.
- **Product updates, not campaigns-in-the-marketing-sense.** Changelogs, release
  notes, "what's new" emails.
- **No contact tax.** You are not billed per subscriber. Pricing is bandwidth:
  you pick a monthly email allowance.
- **Free to build, paid to send.** A free account can set up domains, audiences,
  senders and draft campaigns (up to **500 subscribers**), but **cannot send** —
  sending is what a paid plan unlocks. Paid tiers differ only by monthly email
  allowance and by the size of their **AI writing assistant** allowance — every
  paid tier includes the assistant.
- **Deliverability and compliance are built in, not add-ons:** verified sending
  domains, double opt-in, one-click unsubscribe, automatic bounce/complaint
  suppression, and account auto-pause on bad reputation.
- **Dev-first transactional email, same product.** The same verified domain that
  sends your newsletter sends your password resets — one `POST /v1/emails` call,
  Resend-compatible in shape, with per-email delivery status and a free-tier
  sandbox to integrate before paying (§6.15).
- **Simple by default, deep when you need it.** The common path — write an email,
  pick an audience, send — stays a few clicks. Open and click tracking and a
  deliverability/reputation/engagement dashboard are included (§6.10), and
  audiences support **segments** (saved filters) and **topics** (subscription
  categories) — see §6.3.
- **Planned (designed, not yet shipped): Automations** — a node canvas with
  triggers, branches, waits, and sends for onboarding and lifecycle email.
  Automations and automation runs will be **unlimited on every paid tier** —
  emails stay the only metered resource. Design: `docs/automations-design.md`.

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
set-up-only (no sending). **Every paid tier includes the AI assistant**; tiers
differ in how large an AI allowance they carry.

The AI allowance is denominated in **credits — 1 credit = $0.01 of metered AI
spend** — and has two buckets: a visible 5-hour rolling window (the meter in the
sidebar) and a silent monthly backstop. The monthly figure is the worst case an
org can burn on that tier.

| Plan | Clerk slug | Emails / month | Subscribers | AI assistant (window / month) | Price | $ / 1k |
|------|-----------|----------------|-------------|-------------------------------|-------|--------|
| **Free** | `free_org` | **0 — cannot send** | up to **500** | ❌ none | **$0** | — |
| **1k** | `1k_plan` | **1,000** | unlimited | ✅ 10 / **20** credits | **$1 / mo** | $1.00 |
| **5k** | `5k_plan` | **5,000** | unlimited | ✅ 15 / **50** credits | **$3 / mo** | $0.60 |
| **10k** | `10k_plan` | **10,000** | unlimited | ✅ 20 / **100** credits | **$5 / mo** | $0.50 |
| **25k** | `25k_plan` | **25,000** | unlimited | ✅ 30 / **200** credits | **$8 / mo** | $0.32 |
| **50k** | `50k_plan` | **50,000** | unlimited | ✅ 30 / **200** credits | **$14 / mo** | $0.28 |
| **100k** | `100k_plan` | **100,000** | unlimited | ✅ 30 / **200** credits | **$25 / mo** | $0.25 |
| **250k** | `250k_plan` | **250,000** | unlimited | ✅ 30 / **200** credits | **$60 / mo** | $0.24 |
| **500k** | `500k_plan` | **500,000** | unlimited | ✅ 30 / **200** credits | **$115 / mo** | $0.23 |
| **1M** | `1m_plan` | **1,000,000** | unlimited | ✅ 30 / **200** credits | **$220 / mo** | $0.22 |

**Why the ladder is shaped like this.** Delivery is AWS SES at **$0.10 / 1,000**
and is perfectly linear, so there are no volume economies to pass on — the per-1k
price flattens toward ~$0.22 rather than falling away. At the cheap end the
binding cost is not email at all but **payment processing** (Stripe's ~2.9% +
$0.30, plus Clerk's cut): a $1 charge surrenders roughly a third of its revenue to
fees, which is why the small tiers sit above the $/1k line and why nothing below
$1 is viable monthly. The ladder holds roughly **55–70% gross margin** throughout.

Key pricing facts:

- **Every org starts on the always-active Free tier.** It can do everything except
  send: verify domains, add senders, import/collect subscribers, and draft
  campaigns. **Sending requires a paid plan** (from $1/mo).
- **The free tier is capped at 500 subscribers** (spam/abuse protection — a
  set-up-only account can't hoard a giant list). Paid tiers are unlimited. The cap
  is enforced on every insert path: manual add, CSV import, and public signup forms.
- **The AI writing assistant (draft / subjects / preview / rewrite) is included on
  every paid tier**, sized by the plan's credit allowance above. Only free-tier
  accounts see the "unlock AI" prompt; the AI routes return 403 for the free tier
  only. When a tier's allowance is spent the assistant disables until the window
  (or the month) resets — and a tier below the full allowance is told that
  upgrading buys more. The assistant is the product's differentiator, so a paid
  account always gets to use it rather than only reading about it.
- **Each monthly allowance is a hard cap**, enforced atomically at send time so
  concurrent workers can never over-send. Sending hard-stops at the limit (no
  usage-based overages); the UI surfaces upgrade prompts as the cap approaches.
- **Usage resets** at the start of each billing period (driven by the Clerk
  `subscriptionItem.active` webhook; a monthly cron sweep is the fallback).
- **Above 1M/mo is by arrangement, not self-serve.** The billing page's plan
  picker ends with a "Need more?" card whose "Contact us" opens an in-app form
  (relayed to the support inbox via `POST /api/support`, topic `volume`, with a
  mailto fallback); there is no checkout for a custom tier (operators set one up
  manually, e.g. via the plan metadata override).
- **No per-contact / per-subscriber pricing.** Subscriber count does not affect price.
- **Transactional email draws from the same monthly allowance.** One meter,
  campaign or API send alike — an email is an email. Exception: the free tier's
  **transactional sandbox** — free orgs can send up to **100 API emails/month, to
  their own org members' addresses only** (real SES sends, flagged `sandbox`), so
  a developer can integrate and test `POST /v1/emails` before paying. Upgrading
  lifts both restrictions with no code change.
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

**Slug-mismatch validation.** Because the plan keys *are* the Clerk slugs, a typo
in the Clerk dashboard (`1M_plan` for `1m_plan`) is invisible to the type system
and fails silently — the tier stops resolving and the org reads as Free. Three
guards make that observable:

- **Billing page:** on load it compares Clerk's configured plan slugs against the
  catalog (`missingClerkPlanSlugs`) and logs an error naming every tier Clerk has
  no plan for. Those tiers' CTAs are disabled with a hover explanation. This is
  the proactive check — it fires for an operator before any customer is affected.
- **Subscription webhook:** an unrecognized-but-present slug is treated as *no
  usable slug* (`isUnknownPlanSlug`) — the account **keeps its recorded plan**
  rather than being downgraded to Free — and logs an error. A dashboard typo must
  never strip sending from a paying org.
- **Session sync:** if an account recorded on a paid tier resolves to Free from
  its session billing claims, that is logged as an error. `has()` is a predicate,
  so a mis-spelled slug simply never matches and cannot be detected directly; this
  catches the symptom. **Note:** the session sync still applies the downgrade —
  it only reports it. Making the session refuse to downgrade a paid plan (leaving
  that solely to the `subscriptionItem.ended` webhook, mirroring how it already
  refuses to *re-activate* a past_due row) would close the hole rather than
  observe it, and is worth doing.

---

## 5. Core concepts (domain model)

| Concept | What it is |
|---------|-----------|
| **Account** | The tenant. One per Clerk **organization**. Holds plan, usage, sending status, company mailing address, and a public `slug` for forms. |
| **Account user** | A team member (Clerk user) belonging to an account, with a role (`admin` / `member`). |
| **Audience** | A named list of subscribers. |
| **Subscriber** | A contact in an audience. Status: `subscribed`, `pending` (awaiting double opt-in), `unsubscribed`, `bounced`, `complained`, or `suppressed`. Only `subscribed` contacts receive campaigns. |
| **Sending domain** | A verified email-sending identity (e.g. `news.yourcompany.com`), set up via AWS SES with DKIM/SPF/DMARC DNS records. Campaigns and transactional sends both require a verified domain. Adding one auto-creates its first **sender**. **Globally exclusive:** one domain belongs to one account — the SES identity is shared across the whole platform, so a second account claiming it would inherit its verified status (and could send as it). |
| **Sender** | A saved **From** identity — a from-name + from-address pair (e.g. `Jane from Acme <jane@news.acme.com>`) on a verified sending domain. Campaigns pick a sender instead of typing the From each time; an account can keep several per domain, with one marked default. |
| **Campaign** | A single email send to one audience. Lifecycle: `draft` → (optionally `scheduled`) → `pending_review` → `approved` → `generating_recipients` → `sending` → `sent` (or `paused`, `blocked`, `failed`). |
| **Campaign recipient** | A per-email send record — the source of truth for idempotent, no-duplicate delivery. Tracks delivery status (`pending`, `sending`, `sent`, `delivered`, `bounced`, `complained`, `unsubscribed`, `failed`, `skipped`). |
| **Segment** | A saved, named filter over an audience's subscribers ("plan is pro"), evaluated live — never materialized. Campaigns can send to a segment instead of the whole audience. |
| **Topic** | A subscription category on an audience ("Product updates", "Promotions"). Opt-out model (everyone in by default) or opt-in. Campaigns sent under a topic skip contacts who opted out; the unsubscribe page offers a per-topic opt-out. |
| **Transactional email** | One email sent through the public API (`POST /v1/emails`) — password resets, receipts, magic links. Up to 50 recipients per message, tracked per email: `queued` → `sent` → `delivered` (or `bounced` / `complained` / `failed` / `suppressed`). Listed on the **Emails** page and addressable as `eml_…` over the API. |
| **Form** | A hosted/embeddable signup form that captures new subscribers into an audience. |
| **Suppression entry** | A blocklist record (per-account or global) that prevents sending to an address that unsubscribed, bounced, complained, or was manually suppressed. |
| **Import** | A CSV upload job that adds subscribers to an audience. |
| **Risk review** | An automated spam/abuse assessment of a campaign before it sends: deterministic content checks, plus an optional AI pass that can only raise (never lower) the verdict. Produces a risk level and user-facing fix-it guidance. |

---

## 6. Features

### 6.1 Campaigns
- Create a campaign with name, subject, preview text, a **sender** (From), and an HTML
  body. The **name is an editable page title** at the top of the composer (falls back to
  the subject if left blank).
- **Email-style composer:** the settings (From, Reply-To, To, Subject, Preview)
  read as the header rows at the top of a real email, with the body flowing directly
  beneath — one continuous message surface.
- **To targets an audience, optionally narrowed:** when the audience has saved
  segments, the To row adds a second picker — "Everyone" or a segment (with its live
  contact count). When the audience has topics, a **Topic** row appears: sending under
  a topic skips contacts who opted out and lights up the per-topic choice on the
  unsubscribe page. Both reset when the audience changes; recipient counts, the
  pre-send personalization check, and the "no recipients" gate all respect them.
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
  drops in a fallback automatically. A custom field can also carry a **stored fallback**
  (set on the audience's Fields tab) used when the template has no inline one —
  resolution order: subscriber value → inline fallback → field fallback → empty.
- **Pre-send personalization check:** before sending, the campaign page warns when
  recipients in the chosen audience are missing a field the email uses (e.g. "312 of
  1,200 recipients have no first name — they'll see 'there'"), so a generic greeting
  to a large slice is a deliberate choice, not a surprise.
- **Footer:** shown in the message and editable — you control the wording (the
  "you're receiving this because…" line, which can use merge tags). The physical
  mailing address and the per-recipient one-click unsubscribe link are appended
  automatically at send time and can't be edited or removed (required by law; exactly
  one working link is guaranteed).
- **Send a test email** before sending for real — to your own address (pre-filled) or
  any addresses you type in, up to 5 per test. The subject is prefixed with `[Test]`.
- **Submit & send** kicks off a review → recipient-generation → batched-send pipeline.
- **Schedule for later:** pick a future date/time and the campaign parks in `scheduled`;
  a cron sweep releases it into the same review→send pipeline when due (granularity ~15
  min). Reschedule or cancel (back to `draft`) any time before it fires. If a send gate
  (verified domain, non-empty audience) has lapsed by release time, it returns to `draft`
  with a reason instead of sending.
- **Pause / resume** an in-flight send. System-caused pauses self-heal: a campaign paused
  by a provider rate limit, the provider's daily quota, or the plan's monthly email limit
  is auto-resumed by the cron sweep once the constraint clears (user pauses are never
  auto-resumed). Every mid-send pause also notifies the account admins (in-app + email),
  and the "campaign sent" notification discloses how many recipients could not be sent.
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
- **Risk review** runs before send: deterministic content checks (prohibited industries,
  phishing language, purchased-list/cold-outreach signals, link shorteners, misleading
  subjects, sender-identity mismatch, …) plus an optional AI pass (`AI_REVIEW_MODE=ai`,
  via OpenRouter on a small model) that judges intent/context and can only **escalate**
  the deterministic verdict, never lower it — so content-embedded prompt injection has
  nothing to gain. The AI pass fails open (a model outage falls back to the deterministic
  result) and is platform-funded — never plan-gated, never charged to the org's AI budget.
  Risky campaigns are routed to admin review. A **blocked campaign** shows the sender
  exactly what was flagged, concrete fix-it steps, why it matters for sender reputation,
  and a one-click **Duplicate & fix** path (blocked campaigns themselves are immutable);
  medium-risk campaigns still send but surface the guidance as suggestions for the next
  send. The team also reviews flagged campaigns, so false alarms can be released manually.

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
- **Both buckets are sized by the plan** (see §4) and climb with the price: 1k,
  5k and 10k carry progressively larger starter allowances, and 25k and up carry
  the full one. The free tier has no allowance at all and is held out of the AI
  routes entirely.
- There is currently **no way to buy more** within a tier — the allowance
  replenishes on reset, and **upgrading is the way to get a bigger one** (the
  "budget spent" message says so, unless the org is already on the full
  allowance). Usage is measured from actual model tokens.

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
- **Fields tab (field registry):** the audience page has four tabs — **Contacts**,
  **Fields**, **Segments**, and **Topics** (Resend-style, to make switching from
  Resend/Mailchimp feel familiar). Fields is the single catalogue of the audience's
  custom fields (up to 50):
  each has a human **name**, an immutable merge-tag **key**, an advisory **type**
  (text/number/date), and an optional **fallback value** used in campaigns when a contact
  has no value (a template's inline `{{key|fallback}}` still wins over the field's).
  Fields are **auto-registered** wherever a new key enters the system — signup-form save,
  CSV import, manual subscriber add/edit — and can be created, edited, and deleted by
  hand. Deleting removes the field from menus and columns but keeps stored values by
  default (it can reappear if new data arrives with that column); an explicit option also
  strips the values from all contacts. The registry powers the contacts table's custom
  columns and the composer's merge-tag menu, so all three always agree. Existing
  audiences are seeded automatically from their forms and subscriber data on first view.
- **Segments tab:** saved, named filters over the audience's contacts ("plan is pro",
  "company has any value"), built from up to 10 conditions matched **all**/**any**.
  Conditions cover built-in fields (email, first/last name) and every custom field,
  with operators: is / is not / contains / doesn't contain / has any value / is empty /
  greater than / less than (numeric). Segments are **dynamic** — evaluated live, never
  materialized — so membership always reflects current data. The editor shows a live
  "N contacts match" count; the contacts table can be filtered by segment; the campaign
  composer's To row targets "Everyone" or a segment (up to 25 per audience). Deleting a
  segment is blocked while a scheduled/in-flight campaign targets it; drafts fall back
  to the whole audience.
- **Topics tab:** subscription categories contacts can leave (or join) without
  unsubscribing from everything (up to 20 per audience). A topic is **opt-out**
  (everyone subscribed by default) or **opt-in** (empty until contacts join) — chosen at
  creation and immutable after. A campaign can be sent **under a topic**: contacts
  opted out are skipped at recipient generation, and the public unsubscribe page offers
  "Only stop <topic> emails" alongside the full unsubscribe (one-click header
  unsubscribe is always the full one, per RFC 8058). Per-contact preferences are
  editable in the subscriber edit dialog; the tab shows opt-out/opt-in counts.
- **Add subscribers manually**; **edit** a subscriber's email, name, custom fields, and
  topic preferences, or **delete** one outright (distinct from unsubscribe, which keeps
  the record but stops mailing).
- Search and filter subscribers by status or segment; unsubscribe individuals.
- Subscriber-status breakdown per audience.

### 6.4 Signup forms
One form primitive, multiple install surfaces, all hosted on **`go.day3.app`**:

- **Hosted page** — a shareable link (`go.day3.app/<account>/<form>` pretty URL, or
  `go.day3.app/f/<id>` stable URL) for bios, emails, social.
- **Embed (iframe)** — drop-in snippet for website builders (Webflow, WordPress,
  Squarespace, etc.); auto-resizes via `postMessage`.
- **Popup** — JS widget (`embed.js`) triggered by button click, delay, exit-intent,
  or scroll depth. Auto triggers fire **at most once per browser session** — a visitor
  who dismisses the popup isn't shown it again until their next visit (button clicks
  always open it). Dismissal is easy by design: close button, Escape, or a click on
  the blurred backdrop.
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
widget automatically (the raw-HTML snippet stays "restyle it yourself"). The default
look is a calm, Apple-inspired white card — ink heading, quiet grey body text, hairline
input borders with an accent-tinted focus ring, and a pill-shaped accent button —
applied to every form that hasn't customized its design.
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
- **A domain can only be claimed by one account.** Because a sending domain is a
  single SES identity for the entire platform, adding one that another account
  already has would return SES's account-wide "already verified" state and stamp
  the new row verified with no DNS proof — letting its owner send DKIM-signed,
  DMARC-aligned mail as the other tenant. Adding an already-claimed domain is a
  409, whoever holds it.
- **Auto-check / manual recheck** of verification status.
- **Recovery from a timed-out verification.** SES stops watching for the DKIM
  records 72 hours after a domain is added and then reports a permanent failure.
  If the records are published later, a recheck detects that they resolve
  correctly and reopens verification against them — the published records stay
  valid, so there is nothing for the user to re-add.
- Optional **Return-Path (custom MAIL FROM)** setup for better deliverability.
- **One-click DNS auto-configuration via Cloudflare OAuth** (connect a Cloudflare
  account; Day3 writes the records for you).
  - **Existing records are never overwritten.** The required DKIM records sit at
    names only Day3 uses, so they are always written. The optional deliverability
    records (Return-Path, DMARC) share their names with whatever the account may
    already publish — another provider's Return-Path during a migration, or a
    stricter DMARC policy — so when a different value is already there, Day3 leaves
    it alone and reports it, showing both values side by side for the user to
    decide. Verification is unaffected either way.

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
  plus a public unsubscribe page. When the campaign was sent under a **topic**, the
  page offers "Only stop <topic> emails" alongside the full unsubscribe (the one-click
  header flow is always the full unsubscribe — mail clients present no choice UI).
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
  along the email-volume ladder ("how many emails per month?", free → 1M); the
  matching tier card snaps into focus in a horizontally scrolling row of all tiers
  (scaled up, neighbors dimmed), and scrolling the row moves the slider in sync. Only
  the focused card exposes the billing CTA, which drives Clerk Billing directly —
  upgrades/switches open Clerk Checkout, "Downgrade to Free" opens Clerk's
  subscription drawer to cancel (Clerk handles proration). Past the top tier the
  carousel ends with a dashed "Need more?" card ("Custom" / 1,000,000+ emails/mo;
  the numbers derive from the catalog's top plan, not hardcoded copy)
  whose "Contact us" opens an in-app message form — like the Help widget, it
  relays to the support inbox with the user as Reply-To — custom volume is
  arranged manually, not self-serve.
- Settings: company mailing address (legally required in email footers) and Clerk's
  organization management (team members, org name, logo).
- **Deleting an account is real erasure (GDPR right-to-erasure).** Deleting the
  organization (Clerk's "Delete organization") permanently erases everything it owns —
  subscribers, campaigns, imports, forms, domains, senders, email events, notifications,
  and the account itself — plus its uploaded files (import CSVs, images) and its verified
  SES sending identities. A member deleting their own user is stripped from every org
  they belonged to; an org left with **no members** is erased in full the same way (a
  memberless org is unreachable). The one thing that survives by design: **global
  unsubscribe/complaint suppression records**, so a deleted account can never cause us to
  re-email someone who opted out (a legal duty that outlives the account). Erasure runs
  as a background worker job and is irreversible — there is no grace-window undo.

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

### 6.13 Notifications
Day3 tells you about things that happen while you're not looking, on two channels:
- **In-app bell** in the sidebar (with an unread count) lists recent account events
  newest-first; opening it marks them read. Backed by a `notifications` table.
- **Email** to the account's admins for the same events (so a closed tab isn't a
  blind spot), sent from the Day3 support identity.

Events raised: a **scheduled send that couldn't start** (a gate lapsed by its due
time — the campaign returns to drafts with the reason, and you're told rather than
left to discover it), a **campaign finishing sending** (with the reached count and a
link to its results), and **signups turned away at the free-plan subscriber cap**
(throttled to once a day, with an upgrade link). The service fails open — a
notification never blocks the flow that triggered it.

### 6.14 Public API (v1) — audiences and transactional email over HTTPS

A REST API at **`/api/v1`** does two jobs: it **sends transactional email**
(`POST /v1/emails` — see §6.15) and it exposes everything inside Audiences —
audiences, contacts, custom fields, segments, topics, and the suppression list —
so teams can manage their lists from code and **migrate from another provider**
(Resend, Mailchimp) with a short script. Full reference spec: `docs/api-v1-spec.md`.

- **Auth:** bearer API keys (`day3_live_…`), created and revoked on the **API keys**
  page (its own item in the sidebar), org admins only. The full key is shown once at
  creation; only its SHA-256 hash is stored. Keys cannot manage keys (no key
  endpoints in the public API). Every key belongs to one organization and every
  request is scoped to it.
- **The API keys page is also the documentation.** There is no separate docs site;
  everything needed to use the API sits below the key list, filled in with the
  account's real audience id:
  - a **quickstart** (base URL → `export DAY3_API_KEY=…`, prefilled with the key
    just minted → a verification request),
  - **copy-paste prompts for an AI coding assistant** — *integrate into my app*,
    *migrate from another provider*, *keep my users in sync* — each carrying the
    complete API reference inline, so an assistant writes working code without
    looking anything up. The reference is also copyable on its own, as Markdown to
    drop into a repo's `AGENTS.md` / `CLAUDE.md`. Prompts never contain a live key:
    they instruct the assistant to read `DAY3_API_KEY` from the environment.
  - **cURL / JavaScript / Python snippets** for the things people actually do
    (send a transactional email, add a contact, import a list, unsubscribe
    someone, list contacts, import a suppression list), and a map of every
    endpoint.
  - **A subscriber-cap warning shown up front** on a capped (free) plan, stating
    the exact remaining headroom. An import that would cross the cap is rejected
    whole, on the first batch, so the page says so before anything is copied —
    and the same figure is written into the AI prompts, instructing the assistant
    to count the source rows and stop for an upgrade rather than half-migrate.
- **The API panel (`</>`) brings the API to the resource pages.** Next to the page
  title on Audiences (list and detail), Sending domains (list and detail), and
  Senders sits a small `</>` button that slides out a panel with everything a
  developer needs *for the resource in view*: the base URL, API-key status (with a
  one-click path to create a key when the org has none), **every id on the page as
  a copyable row** (audience id, segment ids, topic ids, field keys, domain and
  sender ids), cURL/JS/Python snippets scoped to the open tab (contacts, fields,
  segments, or topics — prefilled with the real ids), and a copyable **AI context
  pack** — the ids in view plus the full API reference, ready to paste into an
  assistant ahead of any request. Domains and senders have no v1 endpoints; their
  panels say so plainly and show ids for support purposes instead of pretending.
- **Migration-first design:**
  - **Batch endpoint** — up to 1,000 contacts per call with per-row results,
    counting as a single rate-limit request.
  - **Upsert + address-by-email** — contacts are addressable by id *or* email;
    `?upsert=true` merges instead of conflicting.
  - **Bring your opt-outs** — contacts can be created with
    `status: "unsubscribed"`, and the account's **suppression list can be
    imported** (`POST /v1/suppressions`, explicit reason required, add-only via
    API; un-suppression stays a deliberate act in the app).
  - **Custom fields** — free-form `attributes` on contacts auto-register in the
    audience's field registry, same as CSV import.
- **Conventions:** JSON + snake_case, cursor pagination, stable machine-readable
  error codes in one envelope, `Idempotency-Key` replay on POSTs, per-account rate
  limit (~10 req/s) with standard `RateLimit-*` headers.
- **Plan rules apply identically:** the free tier's 500-subscriber cap gates API
  writes too (batches that would cross it are rejected whole, never partially
  applied).

### 6.15 Transactional email — the dev-first sending API

Day3 sends an app's operational email — password resets, receipts, magic links,
alerts — through one Resend-style API call. It is a **headline product surface**:
its own **Emails** page in the sidebar, its own API endpoints, and its own docs
in the API panel. The design goal is "integrated in ten minutes": precise
synchronous errors, copy-paste snippets, and a sandbox that works before paying.

**The API** (auth, conventions, and error envelope shared with the rest of v1):

- `POST /v1/emails` — send. Body: `from` (any local-part on a **verified sending
  domain** — `"Acme <notify@acme.com>"` or a bare address; no pre-created sender
  needed), `to` (string or array, up to **50 recipients** on one message),
  `subject`, `html` and/or `text`, optional `reply_to`, custom `headers`
  (platform-owned ones like `List-Unsubscribe` are reserved), and string
  `tags`. Returns the email object (`eml_…`, `status: "queued"`) immediately;
  delivery is asynchronous and typically takes a couple of seconds.
- `GET /v1/emails/{id}` — the status poll: `queued` → `sent` → `delivered` (or
  `bounced` / `complained` / `failed` / `suppressed`) plus the raw `events`
  timeline. `GET /v1/emails` lists sends, filterable by `?status=`.
- **`Idempotency-Key` makes retries safe** — the single most important
  transactional DX feature; a network-failure retry can never double-send a
  password reset. The key is claimed *before* the send is processed, so even a
  client retry that races its own first attempt resolves to one email (the
  loser gets a "already in progress" 409).
- **Transactional ignores unsubscribes but honors deliverability suppressions**:
  someone who unsubscribed from the newsletter still gets their password reset;
  an address that hard-bounced or complained is rejected up front with
  `email_suppressed`.
- Its own rate bucket (default 120 sends/min per account, env-tunable) inside
  the general API limit, plus an aggregate content-size ceiling.
- **Header-injection hardened**: the `from` display name is emitted as a
  quoted string and may not contain bracket/quote/control characters, so it can
  never smuggle a second mailbox (which in a shared SES account would mean
  sending as another tenant's verified domain); control characters are rejected
  in the subject, header values and addresses; and callers cannot set
  auth/trace headers (`DKIM-Signature`, `Authentication-Results`, `ARC-*`,
  `Received`, `Sender`), the unsubscribe headers, our own attribution headers,
  or any `X-SES-*` (which could redirect event tracking).

**Reliability** (same non-negotiables as campaign sending, §7.2): the API
validates everything synchronously (domain, plan, quota, suppression), persists
the email to Postgres, reserves quota atomically, and enqueues an ID-only job.
Transactional jobs ride the same BullMQ queue at **top priority** — every job
type carries an explicit priority, so a password reset never waits behind a
100k-recipient campaign drain. The worker's send is duplicate-safe by the same
status-ledger claim pattern as campaigns: only provably-unsent errors retry;
ambiguous ones go terminal (observable via the API) rather than risk a double
send. The cron sweep fails crashed sends, re-enqueues lost jobs, gives up
loudly after 6 hours, and prunes bodies after **30 days** (metadata stays).

Bounces and complaints on transactional mail feed the suppression list **and
count toward the account's reputation auto-pause** (§6.7) on equal footing with
campaign sends — the API is the higher-volume path and the one that skips
campaign review, so excluding it would have left the 4%-bounce guard blind
exactly where it matters most.

**The Emails page** (sidebar, between Campaigns and Audiences) is the log: every
API send with status chips, recipient/subject search, a status filter, and a
detail drawer with the delivery timeline, error, tags, provider message id, and
a rendered content preview (until the 30-day prune). Its `</>` API panel carries
verified from-domains, send/status/list snippets, and an AI context pack; the
empty state routes a first-time user to an API key. SES delivery/bounce/
complaint webhooks update each email live — per recipient, since one message can
carry fifty and SES reports each separately — and transactional events appear in
the Activity log (§6.11) alongside campaign events.

**Plans:** sends draw from the same monthly allowance as campaigns; the free
tier gets the member-only 100/month sandbox (§4). Delivery lifecycle statuses,
per-email, come free with the existing SES event pipeline.

> Source of truth in code: routes `app/api/v1/emails/**`, shared vocabulary
> `src/services/transactional.ts`, worker job
> `src/queue/handlers/send-transactional.ts`, sweeps in `src/queue/cron.ts`,
> UI `app/(app)/emails/page.tsx`, docs content `src/lib/api-docs.ts`.

### 6.16 Getting around
- A **command palette** (⌘K / Ctrl-K) jumps to any page or the common create actions
  from anywhere.
- A **plan pill** in the sidebar shows the current tier on every screen; on the free
  plan it links to billing.

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
2. **Review** — the automated risk check (deterministic + optional escalate-only AI
   pass) approves it, or blocks it with user-facing guidance and routes it to admin
   review.
3. **Generate recipients** — eligible (`subscribed`, non-suppressed) subscribers are
   bulk-inserted as `campaign_recipients` (chunked, dedup-safe).
4. **Batched send** — the worker atomically reserves monthly quota, claims ~25 pending
   recipients at a time (`FOR UPDATE SKIP LOCKED`), renders + sends each via SES, and
   re-enqueues until done.
5. **Events** — SES delivery/bounce/complaint events flow back via SNS webhooks and
   update recipient status + suppression.
6. **Sweeps** — cron recovers stuck sends, re-checks pending domains, releases due
   scheduled campaigns, and reconciles campaign completion.

**The transactional path** (§6.15) is the same pipeline minus review and
recipient generation: the API route validates + persists + reserves quota
synchronously, then enqueues a single ID-only `send_transactional` job that
rides the same queue at top priority (explicit per-type priorities keep a
password reset from waiting behind a campaign drain). The same SNS webhook
updates transactional emails' delivery status, and the same cron sweep recovers
their crashed/lost sends.

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

1. **Onboarding:** sign up → create/join an organization → subscribe to a paid plan
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
