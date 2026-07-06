import { eq } from "drizzle-orm";
import type { Db } from "../../db/client";
import type { EmailProvider } from "../../email/provider";
import type { ObjectStore } from "../../lib/storage";
import { sendingDomains } from "../../db/schema";
import { logger } from "../../lib/logger";
import { purgeAccountData } from "../../services/account-purge";

type PurgeAccountMessage = { accountId: string };

type PurgeDeps = {
  db: Db;
  emailProvider: EmailProvider;
  store: ObjectStore;
};

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// Irreversibly erases an account and everything it owns. Triggered by org deletion
// or by the last member of an org deleting their Clerk user (see the Clerk
// webhook). The DB erasure (purgeAccountData) is the authoritative, must-succeed
// step; external teardown — releasing the account's SES sending identities and
// deleting its uploaded files — is best-effort hygiene that must NEVER block or
// fail the purge (the org is gone regardless; a lingering SES identity or blob is
// tolerable, un-erased Postgres PII is not). The whole handler is idempotent, so a
// retry after a partial run re-purges cleanly.
export async function purgeAccount(message: PurgeAccountMessage, deps: PurgeDeps): Promise<void> {
  const { db, emailProvider, store } = deps;
  const { accountId } = message;
  const log = logger.child({ accountId });

  // Capture the SES identities before the rows vanish, so we can release them
  // after the erasure. (Read here rather than after purge — post-purge the rows
  // are gone. If the job crashes before teardown, a retry re-reads them only while
  // the DB purge hasn't yet committed; a dangling identity is acceptable slack.)
  const domains = await db
    .select({ domain: sendingDomains.domain })
    .from(sendingDomains)
    .where(eq(sendingDomains.accountId, accountId));

  // The authoritative erasure. Throws on failure → BullMQ retries.
  await purgeAccountData(db, accountId);

  // Best-effort external hygiene, post-erasure. Never throws.
  if (emailProvider.deleteIdentity) {
    for (const { domain } of domains) {
      try {
        await emailProvider.deleteIdentity(domain);
      } catch (err) {
        log.warn("purge: SES identity teardown failed", { domain, error: errMsg(err) });
      }
    }
  }
  try {
    await store.purgeAccount?.(accountId);
  } catch (err) {
    log.warn("purge: storage teardown failed", { error: errMsg(err) });
  }

  log.info("account purged", { sendingIdentities: domains.length });
}
