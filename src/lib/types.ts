// Shapes returned by the API (subset the UI needs). Q3: the integer 0/1 flags
// are now native booleans (sendingEnabled, adminOverrideVerified).

export type Account = {
  id: string;
  name: string;
  plan: string;
  subscriptionStatus: string;
  monthlyEmailLimit: number;
  monthlyEmailSentCount: number;
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

export type SendingDomain = {
  id: string;
  domain: string;
  fromName: string | null;
  fromEmail: string | null;
  verificationStatus: string;
  dkimStatus?: string;
  dnsRecordsJson?: string | null;
  adminOverrideVerified: boolean;
  createdAt: string;
};

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
