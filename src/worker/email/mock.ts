import type { EmailProvider, SendEmailInput, SendEmailResult } from "./provider";

// Mock provider: logs the email and reports success with a fake message id.
// Never touches the network. Used while EMAIL_PROVIDER=mock.
export class MockEmailProvider implements EmailProvider {
  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const messageId = `mock_${crypto.randomUUID()}`;
    console.log(
      `[mock-email] to=${input.toEmail} from="${input.fromName}" <${input.fromEmail}> ` +
        `subject="${input.subject}" campaign=${input.campaignId ?? "-"} ` +
        `recipient=${input.recipientId ?? "-"} messageId=${messageId}`,
    );
    return { provider: "mock", messageId, status: "sent" };
  }
}
