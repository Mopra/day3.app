// What the UI needs to know about each provider import, with no server code in
// it so a client component can import it. The importers themselves (one file per
// provider next to this one) are server-only and registered in ./index.ts.
//
// Adding a provider: add its id here and a catalog entry, write
// src/importers/<id>.ts implementing ImportProvider (./types.ts), register it in
// ./index.ts, and add its fixtures + tests under test/importers.

export const PROVIDER_IDS = ["beehiiv", "kit", "mailchimp", "mailerlite"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

export type ProviderCatalogEntry = {
  id: ProviderId;
  label: string;
  // What one importable list is called there: "publication", "audience", ...
  sourceNoun: string;
  // Where the user finds the key, in one sentence, and the page that has it.
  keyHelp: string;
  keyHelpUrl: string;
  keyPlaceholder: string;
  // The CSV fallback, for a key that cannot reach the API (a beehiiv plan
  // without API access, for one). Plain steps the user follows in the provider's own app; Day3's CSV
  // importer reads that export's columns as they come (src/lib/csv.ts).
  exportSteps: string[];
};

export const PROVIDER_CATALOG: Record<ProviderId, ProviderCatalogEntry> = {
  beehiiv: {
    id: "beehiiv",
    label: "beehiiv",
    sourceNoun: "publication",
    keyHelp: "In beehiiv, open Settings, then API, and create a new API key.",
    keyHelpUrl: "https://app.beehiiv.com/settings/workspace/api",
    keyPlaceholder: "Your beehiiv API key",
    exportSteps: [
      "In beehiiv, open your subscribers list and choose Export.",
      "Export all subscribers (not only active ones) and download the CSV.",
      "Upload that file here with Import CSV. Unsubscribed people stay unsubscribed.",
    ],
  },
  kit: {
    id: "kit",
    label: "Kit",
    sourceNoun: "account",
    keyHelp: "In Kit, open Settings, then Developer, and add a new V4 API key.",
    keyHelpUrl: "https://app.kit.com/account_settings/developer_settings",
    keyPlaceholder: "Your Kit V4 API key",
    exportSteps: [
      "In Kit, open Grow, then Subscribers.",
      "Select all subscribers, including unsubscribed ones, and choose Export.",
      "Upload the CSV Kit emails you here with Import CSV. Its status column keeps unsubscribed people unsubscribed; bounced, complained and unconfirmed rows are skipped.",
    ],
  },
  mailchimp: {
    id: "mailchimp",
    label: "Mailchimp",
    sourceNoun: "audience",
    keyHelp: "In Mailchimp, open Profile, then Extras, then API keys, and create a key.",
    keyHelpUrl: "https://admin.mailchimp.com/account/api/",
    keyPlaceholder: "Your Mailchimp API key (ends in -us1, -us21, ...)",
    exportSteps: [
      "In Mailchimp, open Audience, then All contacts, and choose Export Audience.",
      "Unzip the download. It holds separate subscribed, unsubscribed and cleaned files.",
      "Import the unsubscribed file too, so those people stay unsubscribed here. Cleaned addresses are skipped.",
    ],
  },
  mailerlite: {
    id: "mailerlite",
    label: "MailerLite",
    sourceNoun: "account",
    keyHelp: "In MailerLite, open Integrations, then MailerLite API, and generate a new token.",
    keyHelpUrl: "https://dashboard.mailerlite.com/integrations/api",
    keyPlaceholder: "Your MailerLite API token",
    exportSteps: [
      "In MailerLite, open Subscribers, filter to Active, and choose Export. Upload that file here with Import CSV.",
      "Then filter to Unsubscribed, export again, and upload that file on Audiences, Suppressions, so those people are never mailed.",
      "MailerLite exports one status per file and may leave the status out, which is why the unsubscribed file goes to Suppressions.",
    ],
  },
};
