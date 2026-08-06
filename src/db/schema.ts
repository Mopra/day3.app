import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { FormField } from "../lib/form-fields";

// IDs are app-generated prefixed strings (acc_, aud_, sub_, cmp_, ...) — see
// lib/ids.ts. Timestamps are native `timestamptz` columns; Drizzle surfaces them
// as ISO-8601 strings (mode: "string") so the domain code keeps using nowIso().
// (Q3 of the migration: native Postgres types — boolean for the old 0/1 flags,
// timestamptz for the old text ISO timestamps.)
const tstz = (name: string) => timestamp(name, { withTimezone: true, mode: "string" });

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    clerkOrgId: text("clerk_org_id").notNull().unique(),
    name: text("name").notNull(),

    // Bandwidth pricing: every org starts on the always-active free tier (set-up,
    // drafts, and sandbox sends to its own team) and buys a monthly send
    // allowance by subscribing to a paid plan. See lib/plans-catalog.ts.
    plan: text("plan").notNull().default("free_org"),
    subscriptionStatus: text("subscription_status").notNull().default("active"),
    monthlyEmailLimit: integer("monthly_email_limit").notNull().default(0),
    monthlyEmailSentCount: integer("monthly_email_sent_count").notNull().default(0),
    currentPeriodStart: tstz("current_period_start"),
    currentPeriodEnd: tstz("current_period_end"),

    sendingEnabled: boolean("sending_enabled").notNull().default(false),
    riskStatus: text("risk_status").notNull().default("normal"),
    pausedReason: text("paused_reason"),

    companyAddress: text("company_address"),

    // Public, human-readable handle used in hosted signup-form URLs
    // (go.day3.app/<slug>/<form-slug>). Nullable: generated lazily the first time
    // an account needs a public surface (see lib/slug.ts). Unique so a slug
    // resolves to exactly one account; NULLs are allowed to coexist (Postgres
    // treats them as distinct in a unique index).
    slug: text("slug").unique(),

    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [index("idx_accounts_clerk_org_id").on(t.clerkOrgId)],
);

export const accountUsers = pgTable(
  "account_users",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    clerkUserId: text("clerk_user_id").notNull(),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [uniqueIndex("uq_account_users_account_user").on(t.accountId, t.clerkUserId)],
);

export const sendingDomains = pgTable(
  "sending_domains",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    domain: text("domain").notNull(),
    fromName: text("from_name"),
    fromEmail: text("from_email"),

    provider: text("provider").notNull().default("ses"),
    providerIdentityId: text("provider_identity_id"),

    verificationStatus: text("verification_status").notNull().default("pending"),
    dkimStatus: text("dkim_status").notNull().default("pending"),
    dnsRecordsJson: text("dns_records_json"),

    // Custom Return-Path (SES custom MAIL FROM). The subdomain we point SES at
    // (send.<domain>) and SES's reported status for it. Deliverability-only:
    // never gates verificationStatus (BehaviorOnMxFailure=USE_DEFAULT_VALUE).
    mailFromDomain: text("mail_from_domain"),
    mailFromStatus: text("mail_from_status").notNull().default("pending"),

    // Auto-DNS: when a customer connects Cloudflare and we write the records for
    // them, we record the resolved zone and a write-error for the UI to surface.
    dnsZoneId: text("dns_zone_id"),
    dnsAutoConfigured: boolean("dns_auto_configured").notNull().default(false),
    dnsWriteError: text("dns_write_error"),

    adminOverrideVerified: boolean("admin_override_verified").notNull().default(false),

    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_sending_domains_account_domain").on(t.accountId, t.domain),
    index("idx_sending_domains_account_id").on(t.accountId),
    index("idx_sending_domains_account_status").on(t.accountId, t.verificationStatus),
  ],
);

// A saved "From" identity — a from-name + from-address pair bound to a sending
// domain. Replaces free-text From entry in the campaign composer: users pick a
// sender from a dropdown. The from address must live on the referenced (verified)
// sending domain. One default sender is auto-created when a domain is added.
// NOTE: campaigns still snapshot fromName/fromEmail at save time (see campaigns),
// so editing or deleting a sender never changes what an already-sent campaign used.
export const senders = pgTable(
  "senders",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    sendingDomainId: text("sending_domain_id").notNull(),
    fromName: text("from_name").notNull(),
    fromEmail: text("from_email").notNull(),
    // Optional default Reply-To suggested into the composer when this sender is
    // picked (null = none; the From address is used).
    replyTo: text("reply_to"),
    // The sender pre-selected in the composer when nothing else is chosen. The
    // first sender for an account (e.g. auto-created with the domain) is default.
    isDefault: boolean("is_default").notNull().default(false),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_senders_account_email").on(t.accountId, t.fromEmail),
    index("idx_senders_account_id").on(t.accountId),
    index("idx_senders_domain_id").on(t.sendingDomainId),
  ],
);

// A customer's connected DNS provider (currently Cloudflare only), authorized via
// OAuth. Tokens are AES-256-GCM encrypted at rest (see lib/crypto.ts) — they are
// credentials to the customer's DNS. One connection per account.
export const dnsIntegrations = pgTable(
  "dns_integrations",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    provider: text("provider").notNull().default("cloudflare"),

    accessTokenEnc: text("access_token_enc").notNull(),
    refreshTokenEnc: text("refresh_token_enc").notNull(),
    expiresAt: tstz("expires_at"),
    scope: text("scope"),

    // Display-only: who the connection is authorized as (e.g. CF account email).
    cfAccountLabel: text("cf_account_label"),
    status: text("status").notNull().default("connected"),

    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_dns_integrations_account_provider").on(t.accountId, t.provider),
    index("idx_dns_integrations_account_id").on(t.accountId),
  ],
);

export const audiences = pgTable(
  "audiences",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    name: text("name").notNull(),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [index("idx_audiences_account_id").on(t.accountId)],
);

export const SUBSCRIBER_STATUSES = [
  // Confirmed and mailable — the only status generate-recipients includes.
  "subscribed",
  // Awaiting double opt-in confirmation (public signup form). NEVER mailed a
  // campaign: generate-recipients filters strictly on status='subscribed', so a
  // pending row is structurally excluded until it confirms. Protects sender
  // reputation against bot/typo signups on public forms.
  "pending",
  "unsubscribed",
  "bounced",
  "complained",
  "suppressed",
] as const;
export type SubscriberStatus = (typeof SUBSCRIBER_STATUSES)[number];

export const subscribers = pgTable(
  "subscribers",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    audienceId: text("audience_id").notNull(),
    email: text("email").notNull(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    // Custom field values keyed by FormField.key (everything beyond email/first/
    // last name). A free-form {key: value} bag so a subscriber can carry whatever
    // a signup form or CSV import collected (phone, company, …); these keys are
    // usable as {{merge_tags}} in campaigns. Null when nothing custom was captured.
    attributes: jsonb("attributes").$type<Record<string, string>>(),
    status: text("status").$type<SubscriberStatus>().notNull().default("subscribed"),
    source: text("source"),
    // The signup form that captured this subscriber (null for import/manual adds).
    formId: text("form_id"),
    importedAt: tstz("imported_at"),
    // Double opt-in: when the subscriber clicked the confirmation link (pending →
    // subscribed). Null while pending or for non-form sources.
    confirmedAt: tstz("confirmed_at"),
    // Consent proof captured at signup (GDPR): the submitter's IP. Stored only
    // for form signups.
    consentIp: text("consent_ip"),
    unsubscribedAt: tstz("unsubscribed_at"),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_subscribers_audience_email").on(t.audienceId, t.email),
    index("idx_subscribers_account_audience").on(t.accountId, t.audienceId),
    index("idx_subscribers_audience_status").on(t.audienceId, t.status),
    index("idx_subscribers_email").on(t.email),
  ],
);

// The per-audience custom-field registry — the single source of truth for which
// custom fields exist on an audience's subscribers. Field VALUES stay in
// subscribers.attributes (schemaless jsonb); these rows catalogue the keys so the
// composer's merge-tag menu, the subscriber table's columns, and the Fields tab
// all agree. Rows are auto-registered when a new key arrives (form save, CSV
// import, manual subscriber edit) and managed on the audience's Fields tab.
export const AUDIENCE_FIELD_TYPES = ["text", "number", "date"] as const;
export type AudienceFieldType = (typeof AUDIENCE_FIELD_TYPES)[number];

export const audienceFields = pgTable(
  "audience_fields",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    audienceId: text("audience_id").notNull(),
    // The stable, merge-tag-safe key ({{key}}) — also the subscribers.attributes
    // key. Immutable after creation: renaming it would orphan stored values.
    key: text("key").notNull(),
    // Human name shown in the UI and the composer's insert menu.
    label: text("label").notNull(),
    // Advisory type (drives display/validation hints, not storage — values are
    // always strings in the attributes bag).
    type: text("type").$type<AudienceFieldType>().notNull().default("text"),
    // Default merge value used at render time when a subscriber has no value and
    // the template supplies no inline {{key|fallback}}.
    fallback: text("fallback"),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_audience_fields_audience_key").on(t.audienceId, t.key),
    index("idx_audience_fields_account_audience").on(t.accountId, t.audienceId),
  ],
);

// A saved, named filter over an audience's subscribers (Resend/Mailchimp-style
// dynamic segment). The filter (see lib/segment-filter.ts) is evaluated at query
// time — browsing the segment and generating a campaign's recipients both apply
// it live, so membership always reflects current subscriber data; nothing is
// materialized.
export const segments = pgTable(
  "segments",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    audienceId: text("audience_id").notNull(),
    name: text("name").notNull(),
    // The validated SegmentFilter as JSON text (match all/any + condition rows).
    filterJson: text("filter_json").notNull(),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [index("idx_segments_account_audience").on(t.accountId, t.audienceId)],
);

// A subscription category contacts can opt in/out of independently of the full
// unsubscribe ("Product updates", "Promotions", …). Campaigns can be sent under
// a topic; recipients opted out of it are excluded, and the unsubscribe page
// offers "just this topic" alongside "everything". defaultSubscribed picks the
// model: true = opt-out (everyone in unless they leave), false = opt-in.
export const topics = pgTable(
  "topics",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    audienceId: text("audience_id").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    defaultSubscribed: boolean("default_subscribed").notNull().default(true),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [index("idx_topics_account_audience").on(t.accountId, t.audienceId)],
);

// A subscriber's explicit deviation from a topic's default: only rows that
// differ from (or confirm) the default exist — absence of a row means the
// topic's defaultSubscribed applies.
export const topicSubscriptions = pgTable(
  "topic_subscriptions",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    topicId: text("topic_id").notNull(),
    subscriberId: text("subscriber_id").notNull(),
    subscribed: boolean("subscribed").notNull(),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_topic_subscriptions_topic_subscriber").on(t.topicId, t.subscriberId),
    index("idx_topic_subscriptions_subscriber").on(t.subscriberId),
  ],
);

export const FORM_STATUSES = ["active", "disabled"] as const;
export type FormStatus = (typeof FORM_STATUSES)[number];

// A hosted/embeddable newsletter signup form. One Form is the single primitive
// behind every public surface (hosted page at go.day3.app/f/<id>, the pretty
// share URL go.day3.app/<account-slug>/<slug>, the iframe embed, and the raw
// HTML snippet) — they all funnel into POST /api/public/forms/<id>/submit. The
// presentation/behaviour fields below render the hosted page and gate the
// double opt-in flow.
export const forms = pgTable(
  "forms",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    // The audience captured signups land in.
    audienceId: text("audience_id").notNull(),
    // Per-account URL handle (go.day3.app/<account-slug>/<slug>). Stable id URL
    // (/f/<id>) is used for embeds so a rename never breaks a live embed.
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    status: text("status").$type<FormStatus>().notNull().default("active"),

    // Confirmed opt-in. ON by default for public forms — protects deliverability
    // (a pending signup is never mailed a campaign). Toggleable per form.
    doubleOptIn: boolean("double_opt_in").notNull().default(true),

    // Presentation (hosted page + iframe render).
    headline: text("headline"),
    description: text("description"),
    buttonLabel: text("button_label").notNull().default("Subscribe"),
    successMessage: text("success_message"),
    // Optional: where to send the browser after a successful submit instead of
    // the hosted thank-you/check-inbox screen.
    redirectUrl: text("redirect_url"),
    collectName: boolean("collect_name").notNull().default(false),
    // Ordered custom fields collected in addition to email. See lib/form-fields.ts.
    // `collectName` is retained for backward compatibility and kept in sync (true
    // iff `fields` contains a first_name field), but `fields` is the source of
    // truth for what the form renders.
    fields: jsonb("fields").$type<FormField[]>().notNull().default([]),
    accentColor: text("accent_color"),
    // Optional text block shown below the form (in addition to headline/description).
    footerText: text("footer_text"),
    // The form's tunable look (backgrounds, text colors, card roundness, top banner
    // image) as a JSON string. See lib/form-design.ts. Null → the default look.
    design: text("design"),

    // Denormalized counters for the dashboard (best-effort, incremented inline).
    submitCount: integer("submit_count").notNull().default(0),
    confirmedCount: integer("confirmed_count").notNull().default(0),

    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_forms_account_slug").on(t.accountId, t.slug),
    index("idx_forms_account_id").on(t.accountId),
  ],
);

export const IMPORT_STATUSES = ["pending", "processing", "completed", "failed"] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];

export const imports = pgTable(
  "imports",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    audienceId: text("audience_id").notNull(),
    r2Key: text("r2_key").notNull(),
    filename: text("filename").notNull(),

    status: text("status").$type<ImportStatus>().notNull().default("pending"),
    totalRows: integer("total_rows").notNull().default(0),
    importedRows: integer("imported_rows").notNull().default(0),
    skippedRows: integer("skipped_rows").notNull().default(0),
    // Why rows were skipped, so the UI can explain "N skipped" instead of a black
    // box: malformed emails, addresses on the suppression list, duplicates
    // (already in the audience), and rows dropped because the free-tier cap was
    // hit. These sum to skippedRows.
    invalidRows: integer("invalid_rows").notNull().default(0),
    suppressedRows: integer("suppressed_rows").notNull().default(0),
    duplicateRows: integer("duplicate_rows").notNull().default(0),
    overCapRows: integer("over_cap_rows").notNull().default(0),
    error: text("error"),

    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [index("idx_imports_account_status").on(t.accountId, t.status)],
);

export const CAMPAIGN_STATUSES = [
  "draft",
  "scheduled",
  "pending_review",
  "approved",
  "generating_recipients",
  "sending",
  "paused",
  "sent",
  "blocked",
  "failed",
] as const;
export type CampaignStatus = (typeof CAMPAIGN_STATUSES)[number];

// Machine-readable pause cause. pausedReason (below) stays the human-facing
// sentence; this code is what the cron sweep keys auto-resume on — string
// matching on the reason text would be fragile. Only rate_limit / daily_limit /
// quota are ever auto-resumed; user / account / config / suspended / error
// require a human (the user, or an operator for config/suspended).
export const PAUSED_CODES = [
  "user", // paused from the UI
  "quota", // monthly email limit reached (auto-resumes when headroom returns)
  "rate_limit", // provider throttled (auto-resumes next sweep)
  "daily_limit", // provider daily quota (auto-resumes after a cool-down)
  "account", // account ineligible (past-due, risk-paused, sending disabled)
  "config", // platform-side sending misconfiguration (ops alerted)
  "suspended", // provider suspended the platform account (ops alerted)
  "error", // repeated identical send failures tripped the circuit breaker
] as const;
export type PausedCode = (typeof PAUSED_CODES)[number];

export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    audienceId: text("audience_id").notNull(),
    // Optional narrowing of the audience: send only to subscribers matching this
    // saved segment (evaluated live at recipient generation). Null = everyone.
    segmentId: text("segment_id"),
    // Optional topic the campaign is sent under: recipients opted out of it are
    // excluded, and the unsubscribe page offers a per-topic opt-out. Null = no
    // topic (only the full unsubscribe applies).
    topicId: text("topic_id"),
    sendingDomainId: text("sending_domain_id").notNull(),
    // The sender picked in the composer. Nullable: provenance only (so a reopened
    // draft re-selects the right option). fromName/fromEmail below remain the
    // authoritative snapshot used at send time, independent of this reference.
    senderId: text("sender_id"),

    name: text("name").notNull(),
    subject: text("subject").notNull(),
    previewText: text("preview_text"),
    fromName: text("from_name").notNull(),
    fromEmail: text("from_email").notNull(),
    replyTo: text("reply_to"),

    htmlBody: text("html_body").notNull(),
    textBody: text("text_body"),

    // The section builder's structured edit-time model (JSON array of sections, see
    // lib/sections.ts), stored as text like riskCategoriesJson. htmlBody above stays
    // the canonical, send-authoritative body and is *derived* from this server-side
    // (so the two can never drift). Null = a legacy/AI-only draft with no sections;
    // the composer wraps htmlBody as a single section when opening it.
    sectionsJson: text("sections_json"),

    // The campaign's global theme — the email-wide styling set from the composer's
    // styling panel (page/content background, text/heading/link colors, border, and
    // corner roundness), stored as JSON (see lib/theme.ts). Unlike htmlBody this is
    // structured, validated data applied at *render time* in a server-built document
    // wrapper, not baked into the body. Null falls back to DEFAULT_THEME.
    themeJson: text("theme_json"),

    // Editable footer wording (the "you're receiving this because…" line). The
    // physical address + the per-recipient unsubscribe link are appended
    // canonically at send time (see services/render.ts) and are never editable.
    // Null falls back to the default sentence.
    footerText: text("footer_text"),

    status: text("status").$type<CampaignStatus>().notNull().default("draft"),

    // True when this campaign entered the send pipeline under the free tier's
    // sandbox carve-out: a real send through the real pipeline, but restricted
    // to the org's own members and metered against SANDBOX_MONTHLY_ALLOWANCE
    // instead of the (zero) plan limit. Stamped once, when the campaign leaves
    // draft — never re-evaluated mid-flight, so an upgrade or downgrade during a
    // send can't change how the in-flight campaign is metered or targeted.
    sandbox: boolean("sandbox").notNull().default(false),

    riskLevel: text("risk_level"),
    riskScore: integer("risk_score"),
    riskSummary: text("risk_summary"),
    riskCategoriesJson: text("risk_categories_json"),

    pausedReason: text("paused_reason"),
    pausedCode: text("paused_code").$type<PausedCode>(),

    scheduledAt: tstz("scheduled_at"),
    sentAt: tstz("sent_at"),

    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    index("idx_campaigns_account_status").on(t.accountId, t.status),
    index("idx_campaigns_account_created").on(t.accountId, t.createdAt),
  ],
);

export const RECIPIENT_STATUSES = [
  "pending",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "unsubscribed",
  "failed",
  "skipped",
] as const;
export type RecipientStatus = (typeof RECIPIENT_STATUSES)[number];

export const campaignRecipients = pgTable(
  "campaign_recipients",
  {
    id: text("id").primaryKey(),
    campaignId: text("campaign_id").notNull(),
    accountId: text("account_id").notNull(),
    subscriberId: text("subscriber_id"),
    email: text("email").notNull(),

    status: text("status").$type<RecipientStatus>().notNull().default("pending"),

    lockedAt: tstz("locked_at"),
    sentAt: tstz("sent_at"),
    deliveredAt: tstz("delivered_at"),
    openedAt: tstz("opened_at"),
    clickedAt: tstz("clicked_at"),
    bouncedAt: tstz("bounced_at"),
    complainedAt: tstz("complained_at"),
    unsubscribedAt: tstz("unsubscribed_at"),

    provider: text("provider").notNull().default("ses"),
    providerMessageId: text("provider_message_id"),
    error: text("error"),

    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_campaign_recipients_campaign_email").on(t.campaignId, t.email),
    index("idx_campaign_recipients_campaign_status").on(t.campaignId, t.status),
    index("idx_campaign_recipients_account_status").on(t.accountId, t.status),
    index("idx_campaign_recipients_provider_message_id").on(t.providerMessageId),
  ],
);

export const EMAIL_EVENT_TYPES = [
  "sent",
  "delivery",
  "bounce",
  "complaint",
  "open",
  "click",
  "unsubscribe",
  "failed",
  "provider_error",
] as const;
export type EmailEventType = (typeof EMAIL_EVENT_TYPES)[number];

export const emailEvents = pgTable(
  "email_events",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    campaignId: text("campaign_id"),
    campaignRecipientId: text("campaign_recipient_id"),

    // Set when the event belongs to a transactional (API) email instead of a
    // campaign send; campaignId/campaignRecipientId stay null on those rows.
    transactionalEmailId: text("transactional_email_id"),

    eventType: text("event_type").$type<EmailEventType>().notNull(),
    email: text("email"),
    provider: text("provider").notNull().default("ses"),
    providerMessageId: text("provider_message_id"),
    payloadJson: text("payload_json"),

    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    index("idx_email_events_campaign_id").on(t.campaignId),
    // The transactional email detail view lists an email's events.
    index("idx_email_events_transactional_email_id").on(t.transactionalEmailId),
    index("idx_email_events_provider_message_id").on(t.providerMessageId),
    // The Activity page lists an account's events newest-first with offset
    // pagination — this composite index serves that scan directly.
    index("idx_email_events_account_created").on(t.accountId, t.createdAt),
    // SNS delivers at-least-once: the same delivery/bounce/complaint notification
    // can arrive multiple times. De-dup on (providerMessageId, eventType, email)
    // so a redelivery is a no-op insert (see onConflictDoNothing in the SES
    // webhook). providerMessageId is nullable; Postgres treats NULLs as
    // distinct, so event types without a message id (e.g. open/click) are
    // unaffected — and every row we write WITH a message id also sets `email`.
    //
    // `email` is part of the key because one transactional message can have up
    // to 50 recipients and SES emits a separate notification per affected
    // address, all sharing one messageId: without the address, recipient #2's
    // bounce would be silently dropped as a duplicate of #1's. For campaign
    // sends (one recipient per messageId) this is identical to the old key.
    uniqueIndex("uq_email_events_provider_message_event").on(
      t.providerMessageId,
      t.eventType,
      t.email,
    ),
  ],
);

// Transactional emails sent through the public API (POST /v1/emails). One row
// per API send — Postgres is the source of truth (the queue message carries the
// id only), and `status` is the ledger that makes the send job idempotent:
//   queued  — accepted by the API, waiting for the worker
//   sending — claimed by a worker (lockedAt drives the stuck-lock sweep)
//   sent    — provider accepted; delivered/bounced/complained arrive via SNS
//   failed  — terminal (bad address, rejected content, ambiguous transport
//             error, or swept stuck lock — never retried, a retry could
//             duplicate)
//   suppressed — every recipient was on the provider's suppression list
// Bodies are pruned (nulled) after TRANSACTIONAL_BODY_RETENTION_DAYS by the
// daily cron; the metadata row is kept forever for the log/API.
export const TRANSACTIONAL_EMAIL_STATUSES = [
  "queued",
  "sending",
  "sent",
  "delivered",
  "bounced",
  "complained",
  "failed",
  "suppressed",
] as const;
export type TransactionalEmailStatus = (typeof TRANSACTIONAL_EMAIL_STATUSES)[number];

export const transactionalEmails = pgTable(
  "transactional_emails",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    // The API key that sent it (attribution/audit; null survives key deletion).
    apiKeyId: text("api_key_id"),

    fromEmail: text("from_email").notNull(),
    fromName: text("from_name"),
    replyTo: text("reply_to"),
    // All recipients of the one message (Resend-style: a single email whose To
    // header lists every address), max MAX_TRANSACTIONAL_RECIPIENTS.
    to: jsonb("to").$type<string[]>().notNull(),
    subject: text("subject").notNull(),
    // Nullable two ways: at least one is required at send time, and both are
    // nulled by the retention prune once the email is older than the window.
    htmlBody: text("html_body"),
    textBody: text("text_body"),
    headers: jsonb("headers").$type<Record<string, string>>(),
    tags: jsonb("tags").$type<Record<string, string>>(),
    // True when sent by a free org in sandbox mode: recipients restricted to the
    // org's own members, on the shared monthly sandbox allowance (see
    // services/sandbox.ts — campaigns carry the same flag).
    sandbox: boolean("sandbox").notNull().default(false),

    status: text("status").$type<TransactionalEmailStatus>().notNull().default("queued"),
    error: text("error"),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    // Stamped when a worker claims the row; the cron sweep fails rows locked
    // longer than the stuck-lock window (crashed worker mid-send).
    lockedAt: tstz("locked_at"),

    sentAt: tstz("sent_at"),
    deliveredAt: tstz("delivered_at"),
    bouncedAt: tstz("bounced_at"),
    complainedAt: tstz("complained_at"),
    // Set when the retention prune nulls the bodies, so the API/UI can say
    // "content expired" instead of implying the email was sent empty.
    bodyPrunedAt: tstz("body_pruned_at"),

    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    // The /emails page and GET /v1/emails list newest-first per account.
    index("idx_transactional_emails_account_created").on(t.accountId, t.createdAt),
    // SNS webhook correlates delivery/bounce/complaint by provider message id.
    index("idx_transactional_emails_provider_message_id").on(t.providerMessageId),
    // The stuck-lock cron sweep scans for status='sending' with an old lock.
    index("idx_transactional_emails_status").on(t.status),
  ],
);

export const SUPPRESSION_REASONS = [
  "unsubscribe",
  "hard_bounce",
  "complaint",
  "manual",
  "provider_suppressed",
] as const;
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number];

export const suppressionEntries = pgTable(
  "suppression_entries",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id"),
    email: text("email").notNull(),
    scope: text("scope").$type<"account" | "global">().notNull().default("account"),
    reason: text("reason").$type<SuppressionReason>().notNull(),
    source: text("source"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_suppression_account_email_reason").on(t.accountId, t.email, t.reason),
    index("idx_suppression_entries_account_email").on(t.accountId, t.email),
  ],
);

export const riskReviews = pgTable("risk_reviews", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  campaignId: text("campaign_id").notNull(),

  riskLevel: text("risk_level").notNull(),
  riskScore: integer("risk_score").notNull(),
  categoriesJson: text("categories_json").notNull(),
  summary: text("summary").notNull(),
  recommendedAction: text("recommended_action").notNull(),

  // User-facing fix-it steps (JSON array of strings) shown on the campaign page
  // when the review flags or blocks the send.
  guidanceJson: text("guidance_json"),
  rawResponseJson: text("raw_response_json"),

  createdAt: tstz("created_at").notNull(),
});

// In-app notifications for account-level events the user needs to know about even
// when the tab is closed (a scheduled send that failed to release, a completed
// import, signups turned away at the plan cap, an auto-pause). Written by
// services/notifications.ts alongside the email it sends; read by the sidebar
// notification bell. Account-scoped; newest-first.
export const NOTIFICATION_KINDS = [
  "scheduled_send_failed",
  "campaign_sent",
  "campaign_paused",
  "campaign_blocked",
  "import_completed",
  "import_failed",
  "subscribers_cap_reached",
  "account_paused",
] as const;
export type NotificationKind = (typeof NOTIFICATION_KINDS)[number];

export const notifications = pgTable(
  "notifications",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    kind: text("kind").$type<NotificationKind>().notNull(),
    title: text("title").notNull(),
    body: text("body").notNull(),
    // Optional in-app link to the page that resolves the notification.
    ctaLabel: text("cta_label"),
    ctaHref: text("cta_href"),
    readAt: tstz("read_at"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [index("idx_notifications_account_created").on(t.accountId, t.createdAt)],
);

// Public-API bearer keys (Authorization: Bearer day3_live_…). Only the SHA-256
// hash of the full key is stored; `keyPrefix` keeps the first characters for
// display in the settings UI ("day3_live_x7Kj9m…"). Keys are created/revoked in
// the web app by org admins only — never via the public API itself, so a leaked
// key cannot mint quieter replacements. Revocation is a soft delete (revokedAt)
// so the settings page can show history and `last used` stays auditable.
export const apiKeys = pgTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    name: text("name").notNull(),
    keyHash: text("key_hash").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    // Elevated scopes this key carries, as a JSON string array. NULL/[] is the
    // norm: every key can already read and write content (audiences, contacts,
    // campaign drafts) — that's the base grant, and it is what the column's
    // absence meant for every key minted before this existed. A scope is only
    // required for an action that *spends real sending reputation*, which today
    // is exactly one: `campaigns:send`. See api/v1/scopes.ts.
    scopes: text("scopes"),
    createdBy: text("created_by").notNull(),
    // Updated at most once per minute on use (write-amplification guard).
    lastUsedAt: tstz("last_used_at"),
    revokedAt: tstz("revoked_at"),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_api_keys_key_hash").on(t.keyHash),
    index("idx_api_keys_account_id").on(t.accountId),
  ],
);

// Idempotency-Key replay store for the public API's POST endpoints. One row per
// (account, endpoint, key); the original response is replayed on retry within
// 24h, and a re-use with a different request body is rejected. Rows past the
// 24h window are treated as absent and lazily deleted on the next lookup — no
// cron dependency.
export const idempotencyKeys = pgTable(
  "idempotency_keys",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    endpoint: text("endpoint").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    // Null while the claiming request is still executing: the row is inserted
    // BEFORE the handler runs (the claim is what makes concurrent duplicates
    // of the same key impossible — see withIdempotency) and completed with the
    // response afterwards.
    responseStatus: integer("response_status"),
    responseBody: text("response_body"),
    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    uniqueIndex("uq_idempotency_account_endpoint_key").on(t.accountId, t.endpoint, t.key),
  ],
);

export const jobLogs = pgTable(
  "job_logs",
  {
    id: text("id").primaryKey(),
    jobType: text("job_type").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    status: text("status").notNull(),
    error: text("error"),
    payloadJson: text("payload_json"),
    createdAt: tstz("created_at").notNull(),
    updatedAt: tstz("updated_at").notNull(),
  },
  (t) => [
    // The table had no index but the PK, and every /api/health probe reads
    // "latest row of this job_type" — a seq scan + sort on a table that grows by
    // ~96 cron rows/day forever. Same shape backs cron's dailyChecksDue marker.
    // Ascending is fine for the ORDER BY … DESC LIMIT 1: Postgres walks a btree
    // backwards at the same cost.
    index("idx_job_logs_type_created").on(t.jobType, t.createdAt),
    // Admin overview: recent failed / dead-lettered work.
    index("idx_job_logs_status_created").on(t.status, t.createdAt),
  ],
);

export type Account = typeof accounts.$inferSelect;
export type AccountUser = typeof accountUsers.$inferSelect;
export type SendingDomain = typeof sendingDomains.$inferSelect;
export type Sender = typeof senders.$inferSelect;
export type DnsIntegration = typeof dnsIntegrations.$inferSelect;
export type Audience = typeof audiences.$inferSelect;
export type AudienceField = typeof audienceFields.$inferSelect;
export type Segment = typeof segments.$inferSelect;
export type Topic = typeof topics.$inferSelect;
export type TopicSubscription = typeof topicSubscriptions.$inferSelect;
export type Subscriber = typeof subscribers.$inferSelect;
export type Form = typeof forms.$inferSelect;
export type Import = typeof imports.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
export type EmailEvent = typeof emailEvents.$inferSelect;
export type TransactionalEmail = typeof transactionalEmails.$inferSelect;
export type SuppressionEntry = typeof suppressionEntries.$inferSelect;
export type RiskReview = typeof riskReviews.$inferSelect;
export type JobLog = typeof jobLogs.$inferSelect;
export type ApiKey = typeof apiKeys.$inferSelect;
export type IdempotencyKey = typeof idempotencyKeys.$inferSelect;
