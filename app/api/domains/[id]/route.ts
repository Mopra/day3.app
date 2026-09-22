import { and, eq, inArray, isNull } from "drizzle-orm";
import { route, json, HttpError } from "@/api/http";
import { requireAccount } from "@/api/context";
import { findDomain } from "@/api/finders";
import { campaigns, sendingDomains } from "@/db/schema";

export const GET = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const domain = await findDomain(db, account.id, id);
  if (!domain) throw new HttpError(404, "Not found");
  return json({ domain });
});

// Campaign states where a domain is actively in use; deleting it mid-flight would
// break the send, so we refuse. Drafts and finished campaigns don't block.
const IN_FLIGHT = ["pending_review", "approved", "generating_recipients", "sending", "paused"] as const;

export const DELETE = route<{ params: Promise<{ id: string }> }>(async (_req, { params }) => {
  const { id } = await params;
  const { db, account } = await requireAccount();
  const domain = await findDomain(db, account.id, id);
  if (!domain) throw new HttpError(404, "Not found");

  // A paused account keeps its domains. Deleting a row is what frees the name
  // for a NEW account (ownership is "does any row hold it"), and a paused
  // account releasing its domain and re-claiming it on a fresh org is precisely
  // how a September 2026 phishing run came back an hour after it was stopped.
  // A ban (blocked_at) is the same story: the row is evidence and the anchor of
  // the block, not the tenant's to remove.
  if (account.riskStatus === "paused" || domain.blockedAt) {
    throw new HttpError(
      403,
      "This domain cannot be removed while the account is paused. Contact support.",
    );
  }

  const blocking = await db.query.campaigns.findFirst({
    where: and(
      eq(campaigns.accountId, account.id),
      eq(campaigns.sendingDomainId, domain.id),
      inArray(campaigns.status, [...IN_FLIGHT]),
      isNull(campaigns.deletedAt),
    ),
  });
  if (blocking) {
    throw new HttpError(409, "A campaign is currently using this domain. Finish or pause it first.");
  }

  // We delete only our record. The SES identity is intentionally left in place:
  // it may be shared by another account that added the same domain, and it is
  // re-created idempotently if the domain is added again.
  await db.delete(sendingDomains).where(eq(sendingDomains.id, domain.id));
  return json({ ok: true });
});
