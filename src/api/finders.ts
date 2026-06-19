import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client";
import { audiences, campaigns, sendingDomains, subscribers } from "../db/schema";

// Account-scoped lookups used across route handlers. The accountId always comes
// from requireAccount() (server-resolved from the Clerk org), never the client.
export function findAudience(db: Db, accountId: string, id: string) {
  return db.query.audiences.findFirst({
    where: and(eq(audiences.id, id), eq(audiences.accountId, accountId)),
  });
}

export function findDomain(db: Db, accountId: string, id: string) {
  return db.query.sendingDomains.findFirst({
    where: and(eq(sendingDomains.id, id), eq(sendingDomains.accountId, accountId)),
  });
}

export function findCampaign(db: Db, accountId: string, id: string) {
  return db.query.campaigns.findFirst({
    where: and(eq(campaigns.id, id), eq(campaigns.accountId, accountId)),
  });
}

export function findSubscriber(db: Db, accountId: string, id: string) {
  return db.query.subscribers.findFirst({
    where: and(eq(subscribers.id, id), eq(subscribers.accountId, accountId)),
  });
}
