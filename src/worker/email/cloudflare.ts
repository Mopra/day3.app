import type { EmailProvider, SendEmailInput, SendEmailResult } from "./provider";

// Structural type for the Cloudflare Email Service send_email binding.
// `wrangler types` generates the real runtime types; this stays compatible.
export type CloudflareEmailBinding = {
  send(message: {
    to: string;
    from: { email: string; name?: string };
    subject: string;
    html?: string;
    text?: string;
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
};

// Cloudflare binding errors carry an E_* code on error.code.
const SUPPRESSED_CODES = new Set(["E_RECIPIENT_SUPPRESSED"]);
const RATE_LIMITED_CODES = new Set(["E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED"]);

export class CloudflareEmailProvider implements EmailProvider {
  constructor(private binding: CloudflareEmailBinding) {}

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    try {
      const response = await this.binding.send({
        to: input.toEmail,
        from: { email: input.fromEmail, name: input.fromName },
        subject: input.subject,
        html: input.html,
        text: input.text,
        headers: input.headers,
      });
      return { provider: "cloudflare", messageId: response.messageId, status: "sent" };
    } catch (err) {
      const code =
        typeof err === "object" && err !== null && "code" in err
          ? String((err as { code: unknown }).code)
          : "E_UNKNOWN";
      const message = err instanceof Error ? err.message : String(err);

      if (SUPPRESSED_CODES.has(code)) {
        return { provider: "cloudflare", status: "suppressed", error: code };
      }
      if (RATE_LIMITED_CODES.has(code)) {
        return { provider: "cloudflare", status: "rate_limited", error: code };
      }
      return { provider: "cloudflare", status: "failed", error: `${code}: ${message}` };
    }
  }
}
