import type { EmailProvider } from "./provider";
import { MockEmailProvider } from "./mock";
import { SesEmailProvider } from "./ses";

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
    if (!config.ses?.region) {
      throw new Error("EMAIL_PROVIDER=ses requires AWS_REGION");
    }
    return new SesEmailProvider({
      region: config.ses.region,
      configurationSet: config.ses.configurationSet,
    });
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
