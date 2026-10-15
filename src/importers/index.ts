import { beehiivProvider } from "./beehiiv";
import type { ProviderId } from "./catalog";
import { kitProvider } from "./kit";
import { mailchimpProvider } from "./mailchimp";
import { mailerliteProvider } from "./mailerlite";
import type { ImportProvider } from "./types";

export { ImportProviderError } from "./http";
export { PROVIDER_CATALOG, PROVIDER_IDS, isProviderId, type ProviderId } from "./catalog";
export type { ImportProvider, ProviderContext, ImportSourceSummary } from "./types";

const PROVIDERS: Record<ProviderId, ImportProvider> = {
  beehiiv: beehiivProvider,
  kit: kitProvider,
  mailchimp: mailchimpProvider,
  mailerlite: mailerliteProvider,
};

export function getImportProvider(id: ProviderId): ImportProvider {
  return PROVIDERS[id];
}
