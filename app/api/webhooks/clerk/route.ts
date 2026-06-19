import type { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { verifyWebhook } from "@clerk/nextjs/webhooks";
import { getDb } from "@/db/client";
import { accounts } from "@/db/schema";
import { nowIso } from "@/lib/ids";
import { logger } from "@/lib/logger";
import {
  applySubscriptionEvent,
  reconcileMembershipByOrg,
  removeAllMemberships,
  removeMembership,
  roleFromClerk,
} from "@/services/accounts";

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
        await db
          .update(accounts)
          .set({ subscriptionStatus: "inactive", sendingEnabled: false, updatedAt: nowIso() })
          .where(eq(accounts.clerkOrgId, orgId));
        // Drop the local members so a deactivated account has no dangling roster.
        await removeAllMemberships(db, orgId);
      }
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
        await removeMembership(db, orgId, userId);
      }
      break;
    }
    // Billing lifecycle. "active" grants the plan; "ended"/"pastDue" revoke it.
    // Accounts are created lazily on first dashboard load, so a missing account
    // here is fine.
    case "subscriptionItem.active":
    case "subscriptionItem.pastDue":
    case "subscriptionItem.ended": {
      const orgId = str(rec(data.payer).organization_id);
      const planSlug = str(rec(data.plan).slug);
      if (orgId) {
        await applySubscriptionEvent(db, {
          clerkOrgId: orgId,
          planSlug,
          active: evt.type === "subscriptionItem.active",
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
