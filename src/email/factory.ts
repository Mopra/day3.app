import type { EmailProvider } from "./provider";
import { MockEmailProvider } from "./mock";

export type EmailProviderConfig = {
  // EMAIL_PROVIDER: "mock" (default) | "ses"
  provider?: string;
  ses?: {
    region: string;
    configurationSet?: string;
  };
};

export function createEmailProvider(config: EmailProviderConfig = {}): EmailProvider {
  if (config.provider === "ses") {
    // Wired in Phase 5 (SesEmailProvider over @aws-sdk/client-sesv2). Until then
    // fail loudly rather than silently mocking — mock must be chosen explicitly.
    throw new Error(
      "EMAIL_PROVIDER=ses is not wired yet (Phase 5). Use EMAIL_PROVIDER=mock for now.",
    );
  }
  return new MockEmailProvider();
}

// Builds the provider from process.env (used by both the test-send route on
// Vercel and the campaign-send worker on the VPS).
export function emailProviderFromEnv(): EmailProvider {
  return createEmailProvider({
    provider: process.env.EMAIL_PROVIDER,
    ses: {
      region: process.env.AWS_REGION ?? "",
      configurationSet: process.env.SES_CONFIGURATION_SET,
    },
  });
}
