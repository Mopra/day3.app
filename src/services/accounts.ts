import { eq } from "drizzle-orm";
import type { ClerkClient } from "@clerk/backend";
import type { Db } from "../db/client";
import { accountUsers, accounts, type Account } from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import { PLANS, type PlanKey } from "./plans";

// The Clerk Billing plan slug for the paid plan. Must match the plan
// configured in the Clerk dashboard.
export const PAID_PLAN_SLUG = "tiny";

type AuthLike = {
  userId: string | null;
  orgId?: string | null;
  has?: (params: { plan: string }) => boolean;
};

export async function getAccountByClerkOrgId(db: Db, clerkOrgId: string): Promise<Account | undefined> {
  return db.query.accounts.findFirst({ where: eq(accounts.clerkOrgId, clerkOrgId) });
}

// Applies plan entitlements to an account row. Never re-enables sending on a
// risk-paused account.
function entitlementFields(account: Pick<Account, "riskStatus">, plan: PlanKey, active: boolean) {
  const planDef = PLANS[plan];
  return {
    plan,
    subscriptionStatus: active ? "active" : "inactive",
    monthlyEmailLimit: planDef.monthlyEmailLimit,
    sendingEnabled: planDef.sendingEnabled && active && account.riskStatus !== "paused",
  };
}

// Resolves the local account for a Clerk organization, creating it on first
// sight, and refreshes entitlements from the session's billing claims.
export async function syncCurrentOrganization(
  db: Db,
  clerk: ClerkClient,
  auth: AuthLike,
): Promise<Account> {
  if (!auth.userId) throw new Error("not signed in");
  if (!auth.orgId) throw new Error("no active organization");

  const hasPaidPlan = auth.has ? auth.has({ plan: `org:${PAID_PLAN_SLUG}` }) : false;
  const plan: PlanKey = hasPaidPlan ? "tiny" : "none";

  let account = await getAccountByClerkOrgId(db, auth.orgId);
  const now = nowIso();

  if (!account) {
    const org = await clerk.organizations.getOrganization({ organizationId: auth.orgId });
    const id = newId("acc");
    await db
      .insert(accounts)
      .values({
        id,
        clerkOrgId: auth.orgId,
        name: org.name,
        ...entitlementFields({ riskStatus: "normal" }, plan, hasPaidPlan),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    // Re-read in case a concurrent request created it first.
    account = await getAccountByClerkOrgId(db, auth.orgId);
    if (!account) throw new Error("failed to create account");
  } else {
    await db
      .update(accounts)
      .set({ ...entitlementFields(account, plan, hasPaidPlan), updatedAt: now })
      .where(eq(accounts.id, account.id));
    account = (await getAccountByClerkOrgId(db, auth.orgId))!;
  }

  // Record the member locally (idempotent).
  const user = await clerk.users.getUser(auth.userId);
  const email =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ?? "";
  await db
    .insert(accountUsers)
    .values({
      id: newId("usr"),
      accountId: account.id,
      clerkUserId: auth.userId,
      email: email.toLowerCase(),
      role: "member",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  return account;
}

// Webhook-driven entitlement update (subscriptionItem.* events).
export async function applySubscriptionEvent(
  db: Db,
  input: {
    clerkOrgId: string;
    planSlug: string | undefined;
    active: boolean;
    periodStart?: string | null;
    periodEnd?: string | null;
  },
): Promise<void> {
  const account = await getAccountByClerkOrgId(db, input.clerkOrgId);
  if (!account) return; // Account is created lazily on first dashboard load.

  const plan: PlanKey = input.active && input.planSlug === PAID_PLAN_SLUG ? "tiny" : "none";
  await db
    .update(accounts)
    .set({
      ...entitlementFields(account, plan, input.active),
      currentPeriodStart: input.periodStart ?? account.currentPeriodStart,
      currentPeriodEnd: input.periodEnd ?? account.currentPeriodEnd,
      updatedAt: nowIso(),
    })
    .where(eq(accounts.id, account.id));
}
