// npm run sending:setup-shared-domain
//
// Sets up the Day3 shared sandbox domain (the "test address" every new account
// sends its first email from) and tells you exactly what to do next.
//
// What it does:
//   1. Creates the SES domain identity for SHARED_SANDBOX_DOMAIN (Easy DKIM,
//      custom Return-Path, attached to SES_CONFIGURATION_SET), or reads it back
//      if it already exists. Idempotent, so re-running is safe and is also how
//      you check progress.
//   2. Prints the DNS records to publish in the zone.
//   3. Reports SES's current verification status.
//
// What it deliberately does NOT do: touch any account row. Accounts pick the
// shared domain up on their next sign-in, from ensureSharedDomain(), once the
// env vars are set on the deployment.
//
// Read docs/onboarding-walkthrough.md for how the feature behaves once this is
// live, and remember the rule it rests on: a shared-domain send must be a
// sandbox send (services/shared-domain.ts), so this identity only ever carries
// mail to an org's own members.
import { config as loadEnv } from "dotenv";
loadEnv({ path: ".env.local" });
loadEnv();

import { createDomainIdentity, getDomainIdentity } from "../src/services/ses-identity";

const domain = process.env.SHARED_SANDBOX_DOMAIN?.trim().toLowerCase();
const region = process.env.AWS_REGION?.trim();
const configurationSet = process.env.SES_CONFIGURATION_SET?.trim() || undefined;
const postal = process.env.DAY3_POSTAL_ADDRESS?.trim();

function fail(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

if (!domain) {
  fail(
    "SHARED_SANDBOX_DOMAIN is not set.\n" +
      "  Pick a dedicated subdomain you own, e.g. sandbox.day3.app.\n" +
      "  Never the apex, and never the domain your own transactional mail leaves\n" +
      "  from: this identity's reputation is shared by every tenant.",
  );
}
if (!region) fail("AWS_REGION is not set.");
// Not a hard stop here: creating the SES identity and publishing DNS does not
// need the address. It is needed before the app boots with the shared domain
// enabled, and validateEnv() enforces it at the point where it actually matters.
// Blocking this step on it would conflate two jobs.
if (!postal) {
  console.warn(
    "\n  Note: DAY3_POSTAL_ADDRESS is not set yet.\n" +
      "  You can finish the SES and DNS setup without it, but the app will refuse\n" +
      "  to boot with SHARED_SANDBOX_DOMAIN set until it is: mail from the shared\n" +
      "  domain carries Day3's own postal address in its footer, and the law\n" +
      "  requires an address in every marketing email.",
  );
}

// An apex domain has one dot at most (example.com). This is advisory, not a
// hard stop: some deployments legitimately own a dedicated apex for this.
if (domain.split(".").length < 3) {
  console.warn(
    `\n  Warning: "${domain}" looks like an apex domain.\n` +
      "  A reputation problem on this identity would then reach every address on\n" +
      "  it, including your own transactional mail. A dedicated subdomain is safer.\n",
  );
}

console.log(`\nShared sandbox domain: ${domain}`);
console.log(`Region:                ${region}`);
console.log(`Configuration set:     ${configurationSet ?? "(none)"}`);

const existing = await getDomainIdentity(domain, region).catch(() => null);
const state = existing?.records.length
  ? existing
  : await createDomainIdentity(domain, region, configurationSet);

console.log(`\nSES status:            ${state.verificationStatus} (DKIM: ${state.dkimStatus})`);
console.log(`Return-Path:           ${state.mailFromDomain} (${state.mailFromStatus})`);

if (state.records.length === 0) {
  fail("SES has not issued DKIM tokens yet. Re-run this in a minute.");
}

console.log("\nPublish these records in your DNS zone:\n");
for (const r of state.records) {
  const flag = r.required ? "required" : "optional";
  const priority = r.priority === undefined ? "" : ` (priority ${r.priority})`;
  console.log(`  [${flag}] ${r.type.padEnd(5)} ${r.name}`);
  console.log(`            -> ${r.value}${priority}`);
  if (r.description) console.log(`            ${r.description}`);
  console.log("");
}

if (state.verificationStatus === "verified") {
  console.log("This domain is verified. Set these on the web tier AND the worker:\n");
  console.log(`  SHARED_SANDBOX_DOMAIN=${domain}`);
  console.log(`  DAY3_POSTAL_ADDRESS=${postal ?? "<your registered postal address>"}`);
  console.log("\nAccounts are provisioned on their next sign-in. Nothing to backfill.\n");
} else {
  console.log(
    "Publish the required records, then re-run this script to check.\n" +
      "SES polls for the DKIM CNAMEs for 72 hours after the identity is created.\n",
  );
}
