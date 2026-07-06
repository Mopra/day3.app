import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { getDb } from "@/db/client";
import { accounts } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logger } from "@/lib/logger";
import { getQueue } from "@/queue/producer";
import {
  applySubscriptionEvent,
  getAccountByClerkOrgId,
  handleUserDeleted,
  reconcileMembershipByOrg,
  removeAllMemberships,
  removeMembershipAndMaybePurge,
  roleFromClerk,
} from "@/services/accounts";
import type { SubscriptionLifecycle } from "@/services/plans";

type Rec = Record<string, unknown>;
const rec = (v: unknown): Rec => (typeof v === "object" && v !== null ? (v as Rec) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const epochToIso = (v: unknown): string | null =>
  typeof v === "number" ? new Date(v).toISOString() : null;

export async function POST(req: NextRequest) {
  // verifyWebhook reads CLERK_WEBHOOK_SIGNING_SECRET from the environment.
  let evt: { type: string; data: unknown };
  try {
    evt = (await verifyWebhook(req)) as { type: string; data: unknown };
  } catch {
    // Unverifiable signature — log a non-sensitive rejection marker (never the
    // body or the signing secret).
    logger.warn("clerk-webhook rejected", { reason: "invalid_signature" });
    return new Response("Webhook verification failed", { status: 400 });
  }

  const db = getDb();
  const data = rec(evt.data);

  switch (evt.type) {
    case "organization.updated": {
      const orgId = str(data.id);
      const name = str(data.name);
      if (orgId && name) {
        await db
          .update(accounts)
          .set({ name, updatedAt: nowIso() })
          .where(eq(accounts.clerkOrgId, orgId));
      }
      break;
    }
    case "organization.deleted": {
      const orgId = str(data.id);
      if (orgId) {
        const account = await getAccountByClerkOrgId(db, orgId);
        // Deactivate immediately — a fast, Redis-free DB write so the account is
        // inert even if the purge enqueue below is delayed — then drop the local
        // roster and hand the heavy, irreversible erasure to the worker. The
        // purge job (purge_account) hard-deletes every account-scoped row plus
        // best-effort external teardown; it's idempotent, so a redelivered webhook
        // re-enqueuing it is harmless.
        await db
          .update(accounts)
          .set({ subscriptionStatus: "inactive", sendingEnabled: false, updatedAt: nowIso() })
          .where(eq(accounts.clerkOrgId, orgId));
        await removeAllMemberships(db, orgId);
        if (account) await getQueue().send({ type: "purge_account", accountId: account.id });
      }
      break;
    }
    // A user deleted their own Clerk account. Strip their PII from every org they
    // belonged to; any org left with no members is purged entirely (a memberless
    // org is unreachable — see handleUserDeleted).
    case "user.deleted": {
      const userId = str(data.id);
      if (userId) await handleUserDeleted(db, getQueue(), userId);
      break;
    }
    // Membership lifecycle: keep account_users in sync with the org roster and
    // each member's role. The account is created lazily on first dashboard load,
    // so a membership event arriving before that is a no-op.
    case "organizationMembership.created":
    case "organizationMembership.updated": {
      const orgId = str(rec(data.organization).id);
      const userData = rec(data.public_user_data);
      const userId = str(userData.user_id);
      const email = str(userData.identifier) ?? "";
      if (orgId && userId) {
        await reconcileMembershipByOrg(db, {
          clerkOrgId: orgId,
          clerkUserId: userId,
          email,
          role: roleFromClerk(str(data.role)),
        });
      }
      break;
    }
    case "organizationMembership.deleted": {
      const orgId = str(rec(data.organization).id);
      const userId = str(rec(data.public_user_data).user_id);
      if (orgId && userId) {
        // Removing the org's last member purges the whole org (unreachable once
        // memberless) — see removeMembershipAndMaybePurge.
        await removeMembershipAndMaybePurge(db, getQueue(), orgId, userId);
      }
      break;
    }
    // Billing lifecycle. "active" grants the plan and enables sending; "pastDue"
    // keeps the plan visible but blocks sending (payment owed); "ended" revokes
    // the plan. Each maps deterministically to subscriptionStatus + sendingEnabled
    // inside applySubscriptionEvent. Accounts are created lazily on first
    // dashboard load, so a missing account here is fine. Handling is idempotent,
    // so a duplicate or out-of-order redelivery converges on the same row.
    case "subscriptionItem.active":
    case "subscriptionItem.pastDue":
    case "subscriptionItem.ended": {
      const orgId = str(rec(data.payer).organization_id);
      const planSlug = str(rec(data.plan).slug);
      const lifecycle: SubscriptionLifecycle =
        evt.type === "subscriptionItem.active"
          ? "active"
          : evt.type === "subscriptionItem.pastDue"
            ? "past_due"
            : "ended";
      if (orgId) {
        await applySubscriptionEvent(db, {
          clerkOrgId: orgId,
          planSlug,
          lifecycle,
          periodStart: epochToIso(data.period_start),
          periodEnd: epochToIso(data.period_end),
        });
      }
      break;
    }
    default:
      break;
  }

  return new Response("OK", { status: 200 });
}
