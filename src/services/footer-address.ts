// Which postal address goes in an email's footer.
//
// CAN-SPAM (and its equivalents) require a valid physical address in every
// marketing email, and services/render.ts renders {{company_address}} into a
// locked footer line that the user cannot edit away. The question this module
// answers is *whose* address that is.
//
// For a customer's own verified domain it is the account's address, and
// campaignSendGateError refuses to send until they have set one. For the Day3
// shared sandbox domain it is Day3's own registered address: on that domain we
// are the sender of record, the recipients are the org's own members, and
// requiring a brand new account to go find its company's postal address before
// it can see a single email work was the last chore standing on day one.
//
// This lives in one function because `companyAddress` is passed into
// renderCampaignEmail from four separate places (services/campaign-send.ts,
// queue/handlers/send-batch.ts, queue/handlers/automation-send.ts and
// api/v1/campaigns.ts). Four copies of this rule would drift, and the failure
// mode of drift here is mail that is out of compliance.

/** Day3's own registered postal address, or null when unconfigured. */
export function day3PostalAddress(): string | null {
  const value = process.env.DAY3_POSTAL_ADDRESS?.trim();
  return value ? value : null;
}

/**
 * The footer address for a send. `domain` is the campaign's resolved sending
 * domain row; pass null when it could not be loaded, which falls back to the
 * account's own address exactly as before.
 *
 * Note this never throws or returns null: lib/env.ts already refuses to boot
 * with SHARED_SANDBOX_DOMAIN set and DAY3_POSTAL_ADDRESS missing, so by the time
 * a shared-domain send reaches here the address exists. The `??` is a belt to
 * that braces, not a real path.
 */
export function footerAddress(
  account: { companyAddress: string | null },
  domain: { shared: boolean } | null,
): string {
  if (domain?.shared) return day3PostalAddress() ?? account.companyAddress ?? "";
  return account.companyAddress ?? "";
}
