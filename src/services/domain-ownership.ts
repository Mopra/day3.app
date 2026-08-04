import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { sendingDomains } from "../db/schema";

// Global (cross-account) sending-domain ownership.
//
// This is a DELIBERATE exception to "every query is scoped by account_id": the
// question it answers is precisely "does this domain belong to a DIFFERENT
// tenant?", which an account-scoped read cannot answer. It lives here in
// services/ rather than inline in the route so the exception is named and
// explained instead of looking like a forgotten scope (see the static guard in
// test/tenant-scoping-guard.test.ts).
//
// Why it has to exist: a sending domain is ONE AWS SES identity for the entire
// platform. If two accounts could hold the same domain, the second one's
// CreateEmailIdentity returns AlreadyExistsException (which we swallow on
// purpose, to support re-adding) and the follow-up GetEmailIdentity reports
// SES's account-wide state — so the new row would be stamped `verified` without
// any DNS proof. Its owner could then send mail that is DKIM-signed and
// DMARC-aligned for a domain they do not control, and every bounce would land
// on the real owner's reputation. Domain uniqueness IS the anti-spoofing
// boundary for both campaign and transactional sending.
//
// Note: the table's unique index is only (account_id, domain), so this check is
// the enforcement point. It leaves a millisecond-wide race between two accounts
// adding the same new domain simultaneously; closing that needs a global unique
// index on `domain`, which can only be added once any pre-existing duplicates
// are resolved to a single owner.
export async function isDomainClaimed(db: Db, domain: string): Promise<boolean> {
  const existing = await db.query.sendingDomains.findFirst({
    where: eq(sendingDomains.domain, domain),
  });
  return !!existing;
}
