import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
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
    this.client = new SESv2Client({ region: config.region });
  }

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const headers = input.headers
      ? Object.entries(input.headers).map(([Name, Value]) => ({ Name, Value }))
      : undefined;

    try {
      const res = await this.client.send(
        new SendEmailCommand({
          FromEmailAddress: input.fromName
            ? `${input.fromName} <${input.fromEmail}>`
            : input.fromEmail,
          ...(input.replyTo ? { ReplyToAddresses: [input.replyTo] } : {}),
          Destination: { ToAddresses: [input.toEmail] },
          ConfigurationSetName: this.config.configurationSet,
          Content: {
            Simple: {
              Subject: { Data: input.subject },
              Body: {
                Html: { Data: input.html },
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
}

// Maps SES SDK errors (which carry a `.name`) to the EmailProvider result
// contract the send-batch handler understands:
//  - rate_limited → unlock the rest of the batch + pause the campaign for resume
//  - error starting "E_SENDER_NOT_VERIFIED" → also flips the domain to unverified
//  - suppressed → skip + add a suppression entry
//  - failed → mark the single recipient failed
function mapSesError(err: unknown): SendEmailResult {
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name: unknown }).name)
      : "UnknownError";
  const message = err instanceof Error ? err.message : String(err);
  const lower = message.toLowerCase();

  switch (name) {
    case "TooManyRequestsException":
    case "LimitExceededException":
      return {
        provider: "ses",
        status: "rate_limited",
        error: /daily|quota/.test(lower) ? "E_DAILY_LIMIT_EXCEEDED" : name,
      };
    case "SendingPausedException":
    case "AccountSuspendedException":
      // Not transient, but pausing the campaign (rate_limited path) is the right
      // response — don't burn the batch; resume once the account is healthy.
      return { provider: "ses", status: "rate_limited", error: name };
    case "MailFromDomainNotVerifiedException":
      return { provider: "ses", status: "failed", error: `E_SENDER_NOT_VERIFIED: ${message}` };
    case "MessageRejected":
      if (lower.includes("suppress")) {
        return { provider: "ses", status: "suppressed", error: name };
      }
      return { provider: "ses", status: "failed", error: `${name}: ${message}` };
    default:
      return { provider: "ses", status: "failed", error: `${name}: ${message}` };
  }
}
