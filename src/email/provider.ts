export type SendEmailInput = {
  accountId: string;
  campaignId?: string;
  recipientId?: string;
  fromEmail: string;
  fromName: string;
  replyTo?: string;
  toEmail: string;
  subject: string;
  html: string;
  text?: string;
  headers?: Record<string, string>;
};

// Status semantics (the send-batch handler branches on these — see the
// duplicate-safety notes in mapSesError before changing them):
//   sent         — the provider accepted the message.
//   failed       — permanent for THIS recipient (bad address, rejected content,
//                  or an ambiguous transport error where the email may have
//                  left — never retried, because a retry could duplicate).
//   suppressed   — the provider's suppression list rejected the address.
//   rate_limited — the provider rejected the request before sending (throttle,
//                  daily quota, account pause/misconfig). Provably not sent, so
//                  the whole remaining batch is safe to return to pending.
//   transient    — the request provably never reached the provider (connection
//                  refused / DNS failure). Safe to retry THIS recipient too.
export type SendEmailResult = {
  provider: "ses" | "mock";
  messageId?: string;
  status: "sent" | "failed" | "suppressed" | "rate_limited" | "transient";
  error?: string;
};

export interface EmailProvider {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}
