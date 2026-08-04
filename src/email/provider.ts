export type SendEmailInput = {
  accountId: string;
  campaignId?: string;
  recipientId?: string;
  fromEmail: string;
  fromName: string;
  replyTo?: string;
  // A single address (campaign sends) or several (transactional API sends —
  // one message whose To header lists every address, Resend-style).
  toEmail: string | string[];
  subject: string;
  // At least one body is required; transactional API sends may be text-only.
  html?: string;
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
  // Releases a verified sending identity (a domain) when its owning account is
  // purged, so a deleted account stops holding identities in the provider.
  // Optional — the mock provider no-ops. Implementations MUST be idempotent:
  // deleting an already-absent identity is a success, not an error (the purge job
  // may retry). Best-effort at the call site; failures never block the purge.
  deleteIdentity?(identity: string): Promise<void>;
}
