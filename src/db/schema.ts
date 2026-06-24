import {
  boolean,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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

    // Bandwidth pricing: every org starts on the always-active free tier (set-up
    // + drafts only, no sending) and buys a monthly send allowance by subscribing
    // to a paid plan. See lib/plans-catalog.ts.
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
    accentColor: text("accent_color"),

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

export const campaigns = pgTable(
  "campaigns",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    audienceId: text("audience_id").notNull(),
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

    // Editable footer wording (the "you're receiving this because…" line). The
    // physical address + the per-recipient unsubscribe link are appended
    // canonically at send time (see services/render.ts) and are never editable.
    // Null falls back to the default sentence.
    footerText: text("footer_text"),

    status: text("status").$type<CampaignStatus>().notNull().default("draft"),

    riskLevel: text("risk_level"),
    riskScore: integer("risk_score"),
    riskSummary: text("risk_summary"),
    riskCategoriesJson: text("risk_categories_json"),

    pausedReason: text("paused_reason"),

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

    eventType: text("event_type").$type<EmailEventType>().notNull(),
    email: text("email"),
    provider: text("provider").notNull().default("ses"),
    providerMessageId: text("provider_message_id"),
    payloadJson: text("payload_json"),

    createdAt: tstz("created_at").notNull(),
  },
  (t) => [
    index("idx_email_events_campaign_id").on(t.campaignId),
    index("idx_email_events_provider_message_id").on(t.providerMessageId),
    // SNS delivers at-least-once: the same delivery/bounce/complaint notification
    // can arrive multiple times. De-dup on (providerMessageId, eventType) so a
    // redelivery is a no-op insert (see onConflictDoNothing in the SES webhook).
    // providerMessageId is nullable; Postgres treats NULLs as distinct, so
    // event types without a message id (e.g. open/click) are unaffected.
    uniqueIndex("uq_email_events_provider_message_event").on(
      t.providerMessageId,
      t.eventType,
    ),
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

  rawResponseJson: text("raw_response_json"),

  createdAt: tstz("created_at").notNull(),
});

export const jobLogs = pgTable("job_logs", {
  id: text("id").primaryKey(),
  jobType: text("job_type").notNull(),
  entityType: text("entity_type"),
  entityId: text("entity_id"),
  status: text("status").notNull(),
  error: text("error"),
  payloadJson: text("payload_json"),
  createdAt: tstz("created_at").notNull(),
  updatedAt: tstz("updated_at").notNull(),
});

export type Account = typeof accounts.$inferSelect;
export type AccountUser = typeof accountUsers.$inferSelect;
export type SendingDomain = typeof sendingDomains.$inferSelect;
export type Sender = typeof senders.$inferSelect;
export type DnsIntegration = typeof dnsIntegrations.$inferSelect;
export type Audience = typeof audiences.$inferSelect;
export type Subscriber = typeof subscribers.$inferSelect;
export type Form = typeof forms.$inferSelect;
export type Import = typeof imports.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
export type EmailEvent = typeof emailEvents.$inferSelect;
export type SuppressionEntry = typeof suppressionEntries.$inferSelect;
export type RiskReview = typeof riskReviews.$inferSelect;
export type JobLog = typeof jobLogs.$inferSelect;
