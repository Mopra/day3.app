// Shapes returned by the API (subset the UI needs). Q3: the integer 0/1 flags
// are now native booleans (sendingEnabled, adminOverrideVerified).

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

export type Subscriber = {
  id: string;
  email: string;
  firstName: string | null;
  lastName: string | null;
  status: string;
  source: string | null;
  createdAt: string;
};

export type ImportRow = {
  id: string;
  filename: string;
  status: string;
  totalRows: number;
  importedRows: number;
  skippedRows: number;
  error: string | null;
  createdAt: string;
};

export type CampaignListItem = {
  id: string;
  name: string;
  subject: string;
  status: string;
  riskLevel: string | null;
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
  sendingDomainId: string;
  fromName: string;
  fromEmail: string;
  htmlBody: string;
  textBody: string | null;
  status: string;
  riskLevel: string | null;
  riskScore: number | null;
  riskSummary: string | null;
  pausedReason: string | null;
  sentAt: string | null;
  createdAt: string;
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
};

export type Recipient = {
  id: string;
  email: string;
  status: string;
  error: string | null;
  sentAt: string | null;
  updatedAt: string;
};

export type RiskReview = {
  riskLevel: string;
  riskScore: number;
  summary: string;
  recommendedAction: string;
  categoriesJson: string;
  createdAt: string;
};

export type AdminReviewRow = {
  campaign: Campaign & { accountId: string };
  accountName: string;
  audienceCount: number;
};
