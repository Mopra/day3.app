// Shapes returned by the API (subset the UI needs). Q3: the integer 0/1 flags
// are now native booleans (sendingEnabled, adminOverrideVerified).
import type { CampaignSection } from "./sections";
import type { CampaignThemeInput } from "./theme";
import type { FormField } from "./form-fields";
import type { FormDesign } from "./form-design";
import type { SegmentFilter } from "./segment-filter";

export type { CampaignSection };
export type { FormField };
export type { FormDesign };
export type { SegmentFilter };

export type Account = {
  id: string;
  name: string;
  plan: string;
  subscriptionStatus: string;
  monthlyEmailLimit: number;
  monthlyEmailSentCount: number;
  currentPeriodEnd: string | null;
  sendingEnabled: boolean;
  riskStatus: string;
  pausedReason: string | null;
  companyAddress: string | null;
  createdAt: string;
};

export type AccountHealth = {
  attempted: number;
  bounced: number;
  complained: number;
  bounceRate: number;
  complaintRate: number;
  status: "normal" | "warning" | "paused";
  reason?: string;
};

// Server-computed onboarding/send state (mirrors services/onboarding.ts). Drives
// the dashboard checklist and the actionable send-blocking messages.
export type OnboardingState = {
  billingActive: boolean;
  hasVerifiedDomain: boolean;
  hasSubscribers: boolean;
  hasCampaign: boolean;
  hasSentCampaign: boolean;
  hasMailingAddress: boolean;
  accountPaused: boolean;
  canSend: boolean;
  sendBlockedReason: string | null;
};

export type SendingDomain = {
  id: string;
  domain: string;
  fromName: string | null;
  fromEmail: string | null;
  verificationStatus: string;
  dkimStatus?: string;
  dnsRecordsJson?: string | null;
  mailFromDomain?: string | null;
  mailFromStatus?: string;
  // Auto-DNS (Cloudflare) bookkeeping the setup guide surfaces: whether we wrote
  // the records for the customer, and the error to show with a manual fallback
  // when that write failed.
  dnsZoneId?: string | null;
  dnsAutoConfigured?: boolean;
  dnsWriteError?: string | null;
  adminOverrideVerified: boolean;
  createdAt: string;
  updatedAt?: string;
};

// A saved "From" identity the user picks in the composer. The list endpoint joins
// the sender to its sending domain so the UI can show the domain + verification.
export type Sender = {
  id: string;
  sendingDomainId: string;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  isDefault: boolean;
  createdAt: string;
  // Joined from the sending domain (present on list/create responses).
  domain?: string;
  verificationStatus?: string;
  adminOverrideVerified?: boolean;
};

// A DNS record the user must publish to verify a sending domain. Mirrors the
// server shape in services/ses-identity.ts — keep the two in lockstep.
export type DnsRecord = {
  type: "CNAME" | "TXT" | "MX";
  name: string;
  value: string;
  description?: string;
  required: boolean;
  // MX records carry a priority (e.g. 10); omitted for CNAME/TXT.
  priority?: number;
  // Which checklist section the record belongs to. "verify" (DKIM) gates the
  // domain's verified state; "deliverability" (Return-Path MX/SPF + DMARC) is
  // optional polish. Optional + defaulted to "verify" for legacy rows.
  group?: "verify" | "deliverability";
};

// Convenience view of a domain's verification state, derived in lib/domain.ts.
export type DomainState = "verified" | "pending" | "failed";

export type Audience = {
  id: string;
  name: string;
  createdAt: string;
  subscriberCount?: number;
};

// A saved dynamic segment (the Segments tab): a named filter over an audience's
// contacts, evaluated live. `count` is the current number of subscribed contacts
// matching (null when the stored filter failed to parse).
export type SegmentRow = {
  id: string;
  name: string;
  filter: SegmentFilter | null;
  count: number | null;
  createdAt: string;
};

// A subscription topic (the Topics tab). defaultSubscribed picks the model:
// true = opt-out (everyone in unless they leave), false = opt-in. optedOut /
// optedIn count explicit deviations from that default.
export type TopicRow = {
  id: string;
  name: string;
  description: string | null;
  defaultSubscribed: boolean;
  optedOut: number;
  optedIn: number;
  createdAt: string;
};

// A subscriber's effective topic subscription (edit dialog): their explicit
// choice, or the topic's default when they never chose.
export type SubscriberTopic = {
  id: string;
  name: string;
  description: string | null;
  subscribed: boolean;
};

// A custom field in an audience's field registry (the Fields tab). Values live
// on subscribers (attributes bag); this is the catalogue entry: the {{key}}
// merge tag, its human label, an advisory type, and an optional default merge
// value used when a subscriber has no value.
export type AudienceField = {
  id: string;
  key: string;
  label: string;
  type: "text" | "number" | "date";
  fallback: string | null;
  createdAt: string;
};

export type Subscriber = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  // Custom field values keyed by FormField.key (phone, company, …). Null/absent
  // when the subscriber carries no custom attributes.
  attributes: Record<string, string> | null;
  status: string;
  source: string | null;
  createdAt: string;
};

export type SignupForm = {
  id: string;
  audienceId: string;
  slug: string;
  name: string;
  status: "active" | "disabled";
  doubleOptIn: boolean;
  collectName: boolean;
  // Ordered custom fields collected in addition to email. See lib/form-fields.ts.
  fields: FormField[];
  headline: string | null;
  description: string | null;
  // Optional text block shown below the form.
  footerText: string | null;
  buttonLabel: string;
  successMessage: string | null;
  redirectUrl: string | null;
  accentColor: string | null;
  // Resolved form design (backgrounds, text colors, roundness, banner image). The
  // detail/list endpoints return this already resolved from the stored JSON.
  design: FormDesign;
  submitCount: number;
  confirmedCount: number;
  createdAt: string;
  updatedAt: string;
  // Only present on the list endpoint.
  audienceName?: string | null;
};

export type FormInstall = {
  hostedUrl: string;
  prettyUrl: string | null;
  iframeSnippet: string;
  htmlSnippet: string;
  inlineSnippet: string;
  popupSnippet: string;
  aiPrompt: string;
};

export type ImportRow = {
  id: string;
  filename: string;
  status: string;
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  // Skip breakdown (sum to skippedRows) — lets the UI explain *why* rows didn't
  // import rather than showing a bare "N skipped".
  invalidRows: number;
  suppressedRows: number;
  duplicateRows: number;
  overCapRows: number;
  error: string | null;
  createdAt: string;
};

export type CampaignListItem = {
  id: string;
  name: string;
  subject: string;
  status: string;
  riskLevel: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
  audienceName: string | null;
  sentCount: number;
};

export type Campaign = {
  id: string;
  name: string;
  subject: string;
  previewText: string | null;
  audienceId: string;
  // Optional audience narrowing (saved segment) and topic — null = everyone /
  // no topic.
  segmentId: string | null;
  topicId: string | null;
  sendingDomainId: string;
  senderId: string | null;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  htmlBody: string;
  // The section builder's structured body (see lib/sections.ts), parsed from the
  // stored JSON by GET /api/campaigns/[id]. Null = legacy/AI-only draft with no
  // sections; the composer then wraps htmlBody as a single section.
  sections: CampaignSection[] | null;
  // The campaign's global theme (see lib/theme.ts), parsed from the stored JSON by
  // GET /api/campaigns/[id]. Null = no saved theme; the composer/render fall back to
  // DEFAULT_THEME.
  theme: CampaignThemeInput | null;
  textBody: string | null;
  footerText: string | null;
  status: string;
  riskLevel: string | null;
  riskScore: number | null;
  riskSummary: string | null;
  pausedReason: string | null;
  scheduledAt: string | null;
  sentAt: string | null;
  createdAt: string;
};

// Why a recipient did not receive the email. `skipped` = suppressed (never
// attempted); `failed` = hard failure on send (bad address / provider error).
export type UndeliverableReason = {
  status: "skipped" | "failed";
  reason: string;
  count: number;
};

export type CampaignStats = {
  total: number;
  pending?: number;
  sending?: number;
  sent?: number;
  delivered?: number;
  bounced?: number;
  complained?: number;
  unsubscribed?: number;
  failed?: number;
  skipped?: number;
  undeliverable?: UndeliverableReason[];
};

// Raw per-campaign send counts powering the Metrics page. Each field is an
// independent count (an email can be delivered AND complained), so they don't
// sum to `recipients`. Rates are derived from these client-side.
//   recipients  — rows generated for the campaign (the send list)
//   sent        — handed to the provider (sent_at set; includes later outcomes)
//   delivered   — confirmed delivered by the provider
//   opened      — recorded at least one open (pixel load or a click)
//   clicked     — clicked at least one tracked link
//   bounced     — hard-bounced
//   complained  — marked as spam
//   unsubscribed— unsubscribed via this campaign
//   failed      — send-time hard failure (bad address / provider error)
//   skipped     — suppressed before sending
export type CampaignMetricCounts = {
  recipients: number;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  bounced: number;
  complained: number;
  unsubscribed: number;
  failed: number;
  skipped: number;
};

export type CampaignMetricsRow = {
  campaignId: string;
  name: string;
  status: string;
  sentAt: string | null;
  counts: CampaignMetricCounts;
};

// Pre-send warning: recipients in the target audience missing a personalization
// field the campaign uses. `fallback` is what they'll see instead (null = blank).
export type PersonalizationGap = {
  field: "first_name" | "last_name";
  fallback: string | null;
  missing: number;
  total: number;
};

export type Recipient = {
  id: string;
  email: string;
  status: string;
  error: string | null;
  sentAt: string | null;
  updatedAt: string;
};

// One row in the account-wide Activity log — an email_events row joined with
// its campaign's name. `payloadJson` is the raw provider payload (SES/SNS
// message, {error} for send failures, {url} for clicks) shown under
// "Technical details".
export type ActivityEvent = {
  id: string;
  eventType: string;
  email: string | null;
  campaignId: string | null;
  campaignName: string | null;
  provider: string;
  providerMessageId: string | null;
  payloadJson: string | null;
  createdAt: string;
};

// One row in the /emails log — a transactional (API-sent) email without its
// bodies (the detail endpoint carries those, until the retention prune).
export type TransactionalEmailListItem = {
  id: string;
  fromEmail: string;
  fromName: string | null;
  to: string[];
  subject: string;
  status: string;
  error: string | null;
  sandbox: boolean;
  tags: Record<string, string> | null;
  providerMessageId: string | null;
  createdAt: string;
  sentAt: string | null;
  deliveredAt: string | null;
  bouncedAt: string | null;
  complainedAt: string | null;
};

export type TransactionalEmailDetail = TransactionalEmailListItem & {
  replyTo: string | null;
  htmlBody: string | null;
  textBody: string | null;
  headers: Record<string, string> | null;
  bodyPrunedAt: string | null;
};

export type TransactionalEmailEvent = {
  id: string;
  eventType: string;
  payloadJson: string | null;
  createdAt: string;
};

export type RiskReview = {
  riskLevel: string;
  riskScore: number;
  summary: string;
  recommendedAction: string;
  categoriesJson: string;
  // JSON array of user-facing fix-it steps; null when the review found nothing.
  guidanceJson: string | null;
  createdAt: string;
};

export type AdminReviewRow = {
  campaign: Campaign & { accountId: string };
  accountName: string;
  audienceCount: number;
};
