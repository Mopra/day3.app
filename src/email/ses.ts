import {
  SESv2Client,
  SendEmailCommand,
  DeleteEmailIdentityCommand,
  GetAccountCommand,
} from "@aws-sdk/client-sesv2";
import type { EmailProvider, SendEmailInput, SendEmailResult } from "./provider";

export type SesConfig = {
  region: string;
  configurationSet?: string;
};

// Raw Amazon SES (SES v2) provider. Credentials come from the default AWS chain
// (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in env). Sends a "Simple" message —
// SES v2 supports custom Headers on Simple content, so the List-Unsubscribe /
// one-click headers carry through without building raw MIME.
export class SesEmailProvider implements EmailProvider {
  private client: SESv2Client;

  constructor(private config: SesConfig) {
    this.client = new SESv2Client({
      region: config.region,
      // SendEmail is NOT idempotent and the SDK's default retry policy
      // (maxAttempts 3) silently re-sends when a response is lost after SES
      // already accepted the message — a duplicate email invisible to the
      // campaign_recipients ledger. Duplicates are the one unrecoverable
      // failure mode here, so the SDK never retries; retry policy lives in
      // the send-batch handler where the ledger can keep it duplicate-safe.
      maxAttempts: 1,
      // Without timeouts a black-holed TCP connection hangs `await send(...)`
      // forever: the job never fails, BullMQ never retries, and the lane is
      // wedged until a process restart. Bound both phases.
      requestHandler: { connectionTimeout: 3000, requestTimeout: 15000 },
    });
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const headers = input.headers
      ? Object.entries(input.headers).map(([Name, Value]) => ({ Name, Value }))
      : undefined;

    try {
      const res = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: formatFromAddress(input.fromName, input.fromEmail),
          ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
          Destination: {
            ToAddresses: Array.isArray(input.toEmail) ? input.toEmail : [input.toEmail],
          },
          ConfigurationSetName: this.config.configurationSet,
          Content: {
            Simple: {
              Subject: { Data: input.subject },
              Body: {
                ...(input.html ? { Html: { Data: input.html } } : {}),
                ...(input.text ? { Text: { Data: input.text } } : {}),
              },
              ...(headers ? { Headers: headers } : {}),
            },
          },
        }),
      );
      return { provider: "ses", messageId: res.MessageId, status: "sent" };
    } catch (err) {
      return mapSesError(err);
    }
  }

  // The account's approved sends-per-second, which SES enforces separately from
  // the 24-hour quota and which the pacer (src/email/send-rate.ts) targets. Read
  // live rather than configured, because AWS raises the ceiling on its own as an
  // account's reputation builds — a number pinned at setup would throttle a grown
  // account to its first-day rate forever. Returns null when SES answers without
  // one; errors propagate so the caller can distinguish "no ceiling reported"
  // from "we could not ask" and fall back conservatively.
  async maxSendRate(): Promise<number | null> {
    const res = await this.client.send(new GetAccountCommand({}));
    const rate = res.SendQuota?.MaxSendRate;
    return typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
  }

  // Deletes a verified domain identity on account purge. Idempotent: SES raises
  // NotFoundException when the identity is already gone, which for a purge is the
  // success path (a retry, or an identity that was never fully created), so we
  // swallow it. Any other error propagates to the caller, which treats identity
  // teardown as best-effort and only logs it.
  async deleteIdentity(identity: string): Promise<void> {
    try {
      await this.client.send(new DeleteEmailIdentityCommand({ EmailIdentity: identity }));
    } catch (err) {
      if ((err as { name?: unknown })?.name === "NotFoundException") return;
      throw err;
    }
  }
}

// Builds the From header value with the display name as an RFC 5322
// quoted-string. Quoting is always valid and is what keeps a name containing
// specials (comma, parens, angle brackets) from being parsed as extra
// addresses — an unquoted `Evil <a@x.com>` display name would smuggle a second
// mailbox into the header. Control characters are stripped outright: they have
// no business in a display name and are the classic header-injection vector.
// Exported for tests.
export function formatFromAddress(name: string | undefined, email: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = (name ?? "").replace(/[\x00-\x1f\x7f]/g, "").trim();
  if (!clean) return email;
  return `"${clean.replace(/[\\"]/g, "\\$&")}" <${email}>`;
}

// Node network errors whose presence (with no HTTP status on the error) proves
// the request never reached SES: the connection was refused or never resolved.
// Only these may be classified "transient" — anything that might have been
// transmitted (reset/timeout after the request was written, any 5xx) must stay
// terminal for the current recipient, because retrying it could duplicate.
const UNSENT_NETWORK_CODES = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

// Error codes send-batch branches on (string contract — see send-batch.ts):
//  - rate_limited + E_DAILY_LIMIT_EXCEEDED → pause until the provider's daily
//    window rolls over (auto-resumed by the cron sweep)
//  - rate_limited + E_ACCOUNT_SUSPENDED → pause + page ops (provider-level
//    suspension affects every tenant; never auto-resumed)
//  - rate_limited + E_SENDING_MISCONFIGURED → pause + page ops (config-set /
//    identity misconfiguration; zero sends can succeed until fixed)
//  - failed + E_SENDER_NOT_VERIFIED → flip the sending domain to unverified
//    and pause the campaign
export const E_DAILY_LIMIT_EXCEEDED = "E_DAILY_LIMIT_EXCEEDED";
export const E_ACCOUNT_SUSPENDED = "E_ACCOUNT_SUSPENDED";
export const E_SENDING_MISCONFIGURED = "E_SENDING_MISCONFIGURED";
export const E_SENDER_NOT_VERIFIED = "E_SENDER_NOT_VERIFIED";

// Maps SES SDK errors to the EmailProvider result contract the send-batch
// handler understands. Duplicate-safety is the organizing principle: a status
// that lets a recipient be retried (rate_limited, transient) is only returned
// when the error proves SES rejected or never received the request.
// Exported for tests — the pause-vs-fail branching in send-batch depends on
// these exact classifications.
export function mapSesError(err: unknown): SendEmailResult {
  const e = (typeof err === "object" && err !== null ? err : {}) as {
    name?: unknown;
    code?: unknown;
    $metadata?: { httpStatusCode?: number };
  };
  const name = typeof e.name === "string" ? e.name : "UnknownError";
  const code = typeof e.code === "string" ? e.code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();
  const httpStatus = e.$metadata?.httpStatusCode;

  // Connection-phase failure: no HTTP status and a "never connected" code means
  // the request provably never left this host — safe to retry the same
  // recipient (the only class where that's true).
  if (httpStatus === undefined && code !== undefined && UNSENT_NETWORK_CODES.has(code)) {
    return { provider: "ses", status: "transient", error: `${code}: ${message}` };
  }

  switch (name) {
    case "TooManyRequestsException":
    case "LimitExceededException":
      return {
        provider: "ses",
        status: "rate_limited",
        error: /daily|quota/.test(lower) ? E_DAILY_LIMIT_EXCEEDED : name,
      };
    case "SendingPausedException":
    case "AccountSuspendedException":
      // SES rejected the request before sending, so the batch is safe to
      // return to pending — but this is a platform-level emergency, not a
      // throttle. The distinct code makes send-batch page ops and prevents
      // the sweep from auto-resuming into a suspended account.
      return { provider: "ses", status: "rate_limited", error: `${E_ACCOUNT_SUSPENDED}: ${name}` };
    case "NotFoundException":
      // SESv2 raises this when SES_CONFIGURATION_SET names a set that doesn't
      // exist (env typo, deleted set). Campaign-global and permanent until an
      // operator fixes it — pausing beats burning every recipient to failed.
      return {
        provider: "ses",
        status: "rate_limited",
        error: `${E_SENDING_MISCONFIGURED}: ${message}`,
      };
    case "MailFromDomainNotVerifiedException":
      return { provider: "ses", status: "failed", error: `${E_SENDER_NOT_VERIFIED}: ${message}` };
    case "MessageRejected":
      if (lower.includes("suppress")) {
        return { provider: "ses", status: "suppressed", error: name };
      }
      // "Email address is not verified" — same class as
      // MailFromDomainNotVerifiedException (identity deleted / wrong region):
      // campaign-global, so route it to the pause-and-flip-domain path instead
      // of failing every recipient one by one.
      if (lower.includes("not verified")) {
        return { provider: "ses", status: "failed", error: `${E_SENDER_NOT_VERIFIED}: ${message}` };
      }
      return { provider: "ses", status: "failed", error: `${name}: ${message}` };
    default:
      // Everything else — including response-phase transport errors
      // (TimeoutError, ECONNRESET) and SES 5xx — is ambiguous: the email may
      // already be queued at SES, so the recipient must NOT be retried.
      // Terminal for this recipient; the send-batch circuit breaker stops a
      // whole batch from grinding to failed on a repeating error.
      return { provider: "ses", status: "failed", error: `${name}: ${message}` };
  }
}
