export type SendEmailInput = {
  accountId: string;
  campaignId?: string;
  recipientId?: string;
  fromEmail: string;
  fromName: string;
  toEmail: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
};

export type SendEmailResult = {
  provider: "cloudflare" | "mock";
  messageId?: string;
  status: "sent" | "failed" | "suppressed" | "rate_limited";
  error?: string;
};

export interface EmailProvider {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}
