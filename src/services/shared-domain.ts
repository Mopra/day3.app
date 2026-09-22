import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sendingDomains, senders } from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { slugify } from "../lib/slug";

// The Day3-owned shared sandbox domain: how a brand new org sends itself a real
// email before it has touched DNS.
//
// The problem it solves: a fresh account had four chores standing between signup
// and any proof the product works (a postal address, a verified domain, an
// audience, and teammates in that audience). The domain was the worst of them,
// because "publish these DNS records" is the highest cliff in the app and it sat
// at the point of lowest investment. So every account is provisioned with one
// pre-verified sending domain pointing at a single SES identity we own, and the
// first send needs no setup at all.
//
// What keeps that safe is the one rule this module exists to state:
//
//   A SHARED-DOMAIN SEND MUST BE A SANDBOX SEND.
//
// The identity's reputation belongs to every tenant at once, so one careless
// account would otherwise spend everyone else's. Sandbox already restricts
// recipients to the org's own members and caps volume at SANDBOX_MONTHLY_ALLOWANCE
// per month, which bounds the blast radius to people who asked for the mail. The
// check lives in campaignSendGateError (and its automation/transactional
// siblings), never in a route handler, and it fails CLOSED: anything that is not
// provably a sandbox send loses access to the shared identity rather than earning
// it. Same reasoning as planSandboxMode deliberately not being !planCanSend.
//
// Unset SHARED_SANDBOX_DOMAIN turns the whole feature off. Accounts are then
// provisioned without a shared row and start on the old verify-first path, which
// is what self-hosters and the test suite want.

/** The configured shared domain, or null when the feature is off. */
export function sharedSandboxDomain(): string | null {
  const value = process.env.SHARED_SANDBOX_DOMAIN?.trim().toLowerCase();
  return value ? value : null;
}

/** Whether an account may currently use the shared domain at all. */
export function sharedDomainEnabled(): boolean {
  return sharedSandboxDomain() !== null;
}

// The local part of the From address, derived from the org name. Not the account
// slug: slugs are assigned lazily (lib/slug.ts) and the shared row is written at
// account creation, before any public surface has needed one. Collisions across
// tenants are fine and expected. The address is a display detail on an identity
// we own, and the reply-to that matters is set per sender.
function localPart(orgName: string): string {
  return slugify(orgName, "team").slice(0, 40);
}

/**
 * Provision the account's shared sandbox domain row. Idempotent: the
 * (account, domain) unique index makes a repeat call a no-op, and an account
 * created before the feature was configured picks one up on its next sync.
 *
 * Returns the row's id, or null when the feature is off.
 */
export async function ensureSharedDomain(
  db: Db,
  account: { id: string; name: string },
): Promise<string | null> {
  const domain = sharedSandboxDomain();
  if (!domain) return null;

  const existing = await db.query.sendingDomains.findFirst({
    where: and(eq(sendingDomains.accountId, account.id), eq(sendingDomains.domain, domain)),
  });
  if (existing) return existing.id;

  const now = nowIso();
  const id = newId("dom");
  await db
    .insert(sendingDomains)
    .values({
      id,
      accountId: account.id,
      domain,
      shared: true,
      fromName: account.name,
      fromEmail: `${localPart(account.name)}@${domain}`,
      provider: "ses",
      // The identity is verified once on the AWS account, by hand, for the whole
      // shared domain, so there is nothing per-tenant to verify and the row starts
      // where a customer domain spends days getting to. It carries no DNS records
      // for the same reason: the user has nothing to publish.
      providerIdentityId: process.env.SHARED_SANDBOX_IDENTITY ?? null,
      verificationStatus: "verified",
      dkimStatus: "verified",
      dnsRecordsJson: null,
      createdAt: now,
      updatedAt: now,
    })
    // A concurrent first request may have inserted it between the read above and
    // here; the unique index makes that harmless.
    .onConflictDoNothing();

  const row = await db.query.sendingDomains.findFirst({
    where: and(eq(sendingDomains.accountId, account.id), eq(sendingDomains.domain, domain)),
  });
  if (!row) return null;

  // A matching sender row, so the shared address is simply an option in every
  // From dropdown (composer, automation settings, the senders list) rather than
  // a special case each of them has to learn about. `isDefault` is left false:
  // the moment the user verifies a domain of their own, their sender should win
  // the auto-selection, and a default pointing at our test address would quietly
  // keep sending their campaigns from it.
  await db
    .insert(senders)
    .values({
      id: newId("snd"),
      accountId: account.id,
      sendingDomainId: row.id,
      fromName: row.fromName ?? account.name,
      fromEmail: row.fromEmail ?? `${localPart(account.name)}@${domain}`,
      replyTo: null,
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  return row.id;
}

/**
 * Whether this domain row is a usable shared row. A row an operator has cut off
 * (`sharedDisabledAt`) is still shared (it must still refuse non-sandbox sends)
 * but it may no longer be sent from at all.
 */
export function sharedDomainUsable(domain: {
  shared: boolean;
  sharedDisabledAt: string | null;
}): boolean {
  return domain.shared && domain.sharedDisabledAt === null;
}

/**
 * The gate. Returns an error string when this send may not use this domain, or
 * null when it may.
 *
 * Called from campaignSendGateError and the automation/transactional send paths,
 * so every front door asks the same question and gets the same answer.
 */
// Deliberately says nothing about why. The recipient of this message is, by
// definition, someone we have already decided not to trust with our mail.
export const BLOCKED_DOMAIN_MESSAGE =
  "This sending domain cannot be used on Day3. Contact support if you believe this is a mistake.";

export function sharedDomainSendError(
  domain: { shared: boolean; sharedDisabledAt: string | null; blockedAt?: string | null },
  opts: { sandbox: boolean },
): string | null {
  // A platform-wide ban outranks everything below, including the shared-domain
  // rules. This is checked HERE, in the one function every send door already
  // calls with the domain row in hand (campaign submit, test send, automation
  // publish, automation send, POST /v1/emails), rather than at each door, so a
  // banned domain is refused everywhere by construction and a new send path
  // cannot forget it. See services/blocked-domains.ts for how a ban is placed.
  if (domain.blockedAt) return BLOCKED_DOMAIN_MESSAGE;
  if (!domain.shared) return null;
  if (domain.sharedDisabledAt !== null) {
    return "This account can no longer send from the Day3 test address. Verify your own sending domain to keep sending.";
  }
  // Fail closed. Not `!sandbox ? error : null` by accident: this is the rule the
  // whole feature rests on, and it must refuse anything it cannot prove.
  if (opts.sandbox !== true) {
    return "The Day3 test address only sends to your own team. Verify your own sending domain to send to your subscribers.";
  }
  return null;
}

/** The account's shared row, if it has a usable one. */
export async function findSharedDomain(db: Db, accountId: string) {
  const domain = sharedSandboxDomain();
  if (!domain) return null;
  const row = await db.query.sendingDomains.findFirst({
    where: and(eq(sendingDomains.accountId, accountId), eq(sendingDomains.shared, true)),
  });
  return row && sharedDomainUsable(row) ? row : null;
}
