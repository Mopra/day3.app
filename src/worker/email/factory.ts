import type { EmailProvider } from "./provider";
import { MockEmailProvider } from "./mock";
import { CloudflareEmailProvider, type CloudflareEmailBinding } from "./cloudflare";

export function createEmailProvider(env: {
  EMAIL_PROVIDER?: string;
  EMAIL?: CloudflareEmailBinding;
}): EmailProvider {
  if (env.EMAIL_PROVIDER === "cloudflare") {
    if (!env.EMAIL) {
      throw new Error("EMAIL_PROVIDER=cloudflare but the EMAIL binding is not configured");
    }
    return new CloudflareEmailProvider(env.EMAIL);
  }
  return new MockEmailProvider();
}
