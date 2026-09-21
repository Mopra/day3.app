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
  // Which class of mail this is, for the account-wide daily budget
  // (src/email/send-budget.ts). Bulk mail yields to transactional mail when the
  // provider's 24-hour ceiling runs short; the default is "transactional"
  // because that class is never held back, so a send path that forgets to
  // classify itself keeps working exactly as before.
  kind?: SendKind;
};

// "bulk" is campaign and automation mail: a large, schedulable fan-out where a
// few hours' delay is recoverable. "transactional" is everything a person is
// waiting for right now (signup confirmations, account notifications, test
// sends, API messages), which is never deferred on our side.
export type SendKind = "bulk" | "transactional";

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

/** What a provider can report about its own rolling 24-hour ceiling. */
export type ProviderSendQuota = {
  /** Emails the provider will accept per rolling 24 hours. */
  max24h: number;
  /** What the provider says it has accepted in the trailing 24 hours. */
  sent24h: number;
  /** The per-second ceiling, when the same call reports it. */
  maxSendRate: number | null;
};

export interface EmailProvider {
  send(input: SendEmailInput): Promise<SendEmailResult>;
  // Releases a verified sending identity (a domain) when its owning account is
  // purged, so a deleted account stops holding identities in the provider.
  // Optional — the mock provider no-ops. Implementations MUST be idempotent:
  // deleting an already-absent identity is a success, not an error (the purge job
  // may retry). Best-effort at the call site; failures never block the purge.
  deleteIdentity?(identity: string): Promise<void>;
  // The provider's current per-second send ceiling, used to configure the pacer
  // (src/email/send-rate.ts). Returns null when the provider is reachable but
  // reports no usable rate. Implement this ONLY on a provider that actually
  // throttles: its absence is what tells the pacer to stay out of the way
  // (the mock has no ceiling worth pacing against).
  maxSendRate?(): Promise<number | null>;
  // The provider's rolling 24-hour ceiling and its own count against it, used by
  // the daily send budget (src/email/send-budget.ts). Implement it ONLY on a
  // provider that actually enforces a daily cap: its absence is what tells the
  // budget to stay out of the way and meter nothing.
  sendQuota?(): Promise<ProviderSendQuota | null>;
}
