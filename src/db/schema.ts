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

    plan: text("plan").notNull().default("none"),
    subscriptionStatus: text("subscription_status").notNull().default("inactive"),
    monthlyEmailLimit: integer("monthly_email_limit").notNull().default(0),
    monthlyEmailSentCount: integer("monthly_email_sent_count").notNull().default(0),
    currentPeriodStart: tstz("current_period_start"),
    currentPeriodEnd: tstz("current_period_end"),

    sendingEnabled: boolean("sending_enabled").notNull().default(false),
    riskStatus: text("risk_status").notNull().default("normal"),
    pausedReason: text("paused_reason"),

    companyAddress: text("company_address"),

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
  "subscribed",
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
    importedAt: tstz("imported_at"),
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

    name: text("name").notNull(),
    subject: text("subject").notNull(),
    previewText: text("preview_text"),
    fromName: text("from_name").notNull(),
    fromEmail: text("from_email").notNull(),

    htmlBody: text("html_body").notNull(),
    textBody: text("text_body"),

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
export type Audience = typeof audiences.$inferSelect;
export type Subscriber = typeof subscribers.$inferSelect;
export type Import = typeof imports.$inferSelect;
export type Campaign = typeof campaigns.$inferSelect;
export type CampaignRecipient = typeof campaignRecipients.$inferSelect;
export type EmailEvent = typeof emailEvents.$inferSelect;
export type SuppressionEntry = typeof suppressionEntries.$inferSelect;
export type RiskReview = typeof riskReviews.$inferSelect;
export type JobLog = typeof jobLogs.$inferSelect;
