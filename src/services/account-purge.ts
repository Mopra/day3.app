import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import {
  accountUsers,
  accounts,
  audienceFields,
  audiences,
  campaignRecipients,
  campaigns,
  dnsIntegrations,
  emailEvents,
  forms,
  imports,
  notifications,
  riskReviews,
  segments,
  senders,
  sendingDomains,
  subscribers,
  suppressionEntries,
  topicSubscriptions,
  topics,
} from "../db/schema";

// Hard-deletes every row an account owns, then the account itself — the DB half of
// an account/org purge (queue/handlers/purge-account.ts adds best-effort external
// teardown). Runs in one transaction so the account is either fully gone or, on a
// mid-way failure, left intact for the job's retry to finish. The purge is
// idempotent, so a retry (or a redelivered webhook) re-running it is a clean no-op
// on already-empty tables.
//
// Every account-scoped table carries `account_id` directly — there are no FK
// cascades to lean on (see schema.ts) — so each is a single scoped DELETE and the
// order is irrelevant for referential integrity; children are simply listed before
// their parents for readability. `job_logs` is intentionally excluded: it is
// operational telemetry with no account_id and no subscriber PII.
//
// The ONE thing that deliberately survives: global-scope suppression entries. A
// scope='global' row is a recipient's platform-wide "never email me"
// (hard-bounce / complaint / unsubscribe); honoring it is a legal duty that
// outlives the account, and it protects every other tenant's deliverability.
// Those rows can carry this account's id (the account whose send first tripped
// them), so suppression is deleted by (account_id AND scope='account') — never by
// account_id alone, which would take the global rows with it.
export async function purgeAccountData(db: Db, accountId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.delete(campaignRecipients).where(eq(campaignRecipients.accountId, accountId));
    await tx.delete(emailEvents).where(eq(emailEvents.accountId, accountId));
    await tx.delete(riskReviews).where(eq(riskReviews.accountId, accountId));
    await tx.delete(notifications).where(eq(notifications.accountId, accountId));
    await tx.delete(topicSubscriptions).where(eq(topicSubscriptions.accountId, accountId));
    await tx.delete(topics).where(eq(topics.accountId, accountId));
    await tx.delete(segments).where(eq(segments.accountId, accountId));
    await tx.delete(audienceFields).where(eq(audienceFields.accountId, accountId));
    await tx.delete(subscribers).where(eq(subscribers.accountId, accountId));
    await tx.delete(imports).where(eq(imports.accountId, accountId));
    await tx.delete(forms).where(eq(forms.accountId, accountId));
    await tx.delete(campaigns).where(eq(campaigns.accountId, accountId));
    await tx.delete(senders).where(eq(senders.accountId, accountId));
    await tx.delete(sendingDomains).where(eq(sendingDomains.accountId, accountId));
    await tx.delete(dnsIntegrations).where(eq(dnsIntegrations.accountId, accountId));
    await tx.delete(audiences).where(eq(audiences.accountId, accountId));
    await tx.delete(accountUsers).where(eq(accountUsers.accountId, accountId));
    // Account-scoped suppression only — global rows must survive (see above).
    await tx
      .delete(suppressionEntries)
      .where(
        and(
          eq(suppressionEntries.accountId, accountId),
          eq(suppressionEntries.scope, "account"),
        ),
      );
    await tx.delete(accounts).where(eq(accounts.id, accountId));
  });
}
