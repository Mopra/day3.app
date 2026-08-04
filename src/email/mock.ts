import type { EmailProvider, SendEmailInput, SendEmailResult } from "./provider";

// Mock provider: logs the email and reports success with a fake message id.
// Never touches the network. Used while EMAIL_PROVIDER=mock.
export class MockEmailProvider implements EmailProvider {
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const messageId = `mock_${crypto.randomUUID()}`;
    const to = Array.isArray(input.toEmail) ? input.toEmail.join(",") : input.toEmail;
    console.log(
      `[mock-email] to=${to} from="${input.fromName}" <${input.fromEmail}> ` +
        `subject="${input.subject}" campaign=${input.campaignId ?? "-"} ` +
        `recipient=${input.recipientId ?? "-"} messageId=${messageId}`,
    );
    return { provider: "mock", messageId, status: "sent" };
  }

  async deleteIdentity(identity: string): Promise<void> {
    console.log(`[mock-email] deleteIdentity identity=${identity}`);
  }
}
