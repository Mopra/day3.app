// Platform-wide domain bans.
//
// Domain ownership (`isDomainClaimed`) asks whether any sending_domains row holds
// a name. That is an ownership rule, not a ban: the moment the holding row is
// deleted the name is free again, and a paused account can still log in and
// delete its rows. In September 2026 an attacker did exactly that — released
// two lookalike domains from his paused accounts, re-verified them on a fresh
// org an hour later, and resumed. This module is what makes "this domain is
// done on Day3" stick across accounts.
//
// Two halves, both needed:
//   - `blocked_domains` is consulted before a row is ever created, so the name
//     cannot be added to any account, new or old.
//   - `sending_domains.blocked_at` is stamped on every existing row for the
//     name, and `sharedDomainSendError` (the one gate every send door already
//     calls) refuses a stamped row. So a ban takes effect on mail in flight
//     without a second lookup on the send path.
//
// Operator-only. There is deliberately no self-serve way to lift a ban.
import { eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { blockedDomains, sendingDomains, type BlockedDomain } from "../db/schema";
import { nowIso } from "../lib/ids";

export function normaliseDomain(domain: string): string {
  return domain.trim().toLowerCase().replace(/\.$/, "");
}

export async function isDomainBlocked(db: Db, domain: string): Promise<boolean> {
  const row = await db.query.blockedDomains.findFirst({
    where: eq(blockedDomains.domain, normaliseDomain(domain)),
  });
  return !!row;
}

/**
 * Bans a domain platform-wide and cuts off every account currently holding it.
 * Idempotent: banning an already-banned name re-stamps the rows and returns.
 */
export async function blockDomain(
  db: Db,
  input: { domain: string; reason: string; sourceAccountId?: string | null; createdBy: string },
): Promise<{ domain: string; rowsStamped: number }> {
  const domain = normaliseDomain(input.domain);
  const now = nowIso();

  await db
    .insert(blockedDomains)
    .values({
      domain,
      reason: input.reason,
      sourceAccountId: input.sourceAccountId ?? null,
      createdBy: input.createdBy,
      createdAt: now,
    })
    .onConflictDoNothing();

  const stamped = await db
    .update(sendingDomains)
    .set({ blockedAt: now, updatedAt: now })
    .where(eq(sendingDomains.domain, domain))
    .returning({ id: sendingDomains.id });

  return { domain, rowsStamped: stamped.length };
}

export async function listBlockedDomains(db: Db): Promise<BlockedDomain[]> {
  return db.select().from(blockedDomains).orderBy(blockedDomains.createdAt);
}
