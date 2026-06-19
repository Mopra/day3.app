import { and, eq } from "drizzle-orm";
import type { ClerkClient } from "@clerk/backend";
import type { Db } from "../db/client";
import { accountUsers, accounts, type Account } from "../db/schema";
import { newId, nowIso } from "../lib/ids";
import {
  PAID_PLAN_SLUG,
  entitlementsFor,
  isPlanKey,
  planFromSlug,
  type PlanKey,
  type SubscriptionLifecycle,
} from "./plans";

export { PAID_PLAN_SLUG };

// Local membership roles. Clerk org roles arrive prefixed (e.g. "org:admin");
// anything that is not an admin is recorded as a plain member.
export type AccountRole = "admin" | "member";

export function roleFromClerk(clerkRole: string | null | undefined): AccountRole {
  return clerkRole === "org:admin" || clerkRole === "admin" ? "admin" : "member";
}

// Upserts the local membership row for (account, user). Race-safe and
// idempotent: a redelivered webhook or a concurrent first load converges on the
// same row, and the role/email are reconciled to the latest Clerk state.
export async function reconcileMembership(
  db: Db,
  input: { accountId: string; clerkUserId: string; email: string; role: AccountRole },
): Promise<void> {
  const now = nowIso();
  await db
    .insert(accountUsers)
    .values({
      id: newId("usr"),
      accountId: input.accountId,
      clerkUserId: input.clerkUserId,
      email: input.email.toLowerCase(),
      role: input.role,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [accountUsers.accountId, accountUsers.clerkUserId],
      set: { email: input.email.toLowerCase(), role: input.role, updatedAt: now },
    });
}

// Removes a single membership (organizationMembership.deleted webhook).
export async function removeMembership(
  db: Db,
  clerkOrgId: string,
  clerkUserId: string,
): Promise<void> {
  const account = await getAccountByClerkOrgId(db, clerkOrgId);
  if (!account) return;
  await db
    .delete(accountUsers)
    .where(
      and(eq(accountUsers.accountId, account.id), eq(accountUsers.clerkUserId, clerkUserId)),
    );
}

// Removes every membership for an org (organization.deleted webhook) so we never
// leave dangling members pointing at a deactivated account.
export async function removeAllMemberships(db: Db, clerkOrgId: string): Promise<void> {
  const account = await getAccountByClerkOrgId(db, clerkOrgId);
  if (!account) return;
  await db.delete(accountUsers).where(eq(accountUsers.accountId, account.id));
}

// Reconciles a membership from a webhook payload, resolving the account by org.
// A missing account is fine: it is created lazily on first dashboard load and
// will reconcile the member then.
export async function reconcileMembershipByOrg(
  db: Db,
  input: { clerkOrgId: string; clerkUserId: string; email: string; role: AccountRole },
): Promise<void> {
  const account = await getAccountByClerkOrgId(db, input.clerkOrgId);
  if (!account) return;
  await reconcileMembership(db, {
    accountId: account.id,
    clerkUserId: input.clerkUserId,
    email: input.email,
    role: input.role,
  });
}

type AuthLike = {
  userId: string | null;
  orgId?: string | null;
  has?: (params: { plan: string }) => boolean;
};

export async function getAccountByClerkOrgId(db: Db, clerkOrgId: string): Promise<Account | undefined> {
  return db.query.accounts.findFirst({ where: eq(accounts.clerkOrgId, clerkOrgId) });
}

// Applies plan entitlements to an account row. Delegates the (plan, lifecycle)
// -> status/limit/sendingEnabled decision to the centralized entitlementsFor so
// the session sync and the webhook stay in lockstep. Never re-enables sending on
// a risk-paused account.
function entitlementFields(
  account: Pick<Account, "riskStatus">,
  plan: PlanKey,
  lifecycle: SubscriptionLifecycle,
) {
  return entitlementsFor(plan, lifecycle, { riskPaused: account.riskStatus === "paused" });
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

  // The session's billing claim only tells us whether the org currently holds an
  // active paid plan. A past_due / ended subscription is carried by the webhook
  // (which has the lifecycle); the session claim drops to no-plan, which we treat
  // as "ended" here. We never downgrade an active row to past_due from the
  // session — only the webhook moves an account into past_due.
  const hasPaidPlan = auth.has ? auth.has({ plan: `org:${PAID_PLAN_SLUG}` }) : false;
  const plan: PlanKey = hasPaidPlan ? "tiny" : "none";
  const lifecycle: SubscriptionLifecycle = hasPaidPlan ? "active" : "ended";

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
        ...entitlementFields({ riskStatus: "normal" }, plan, lifecycle),
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    // Re-read in case a concurrent request created it first.
    account = await getAccountByClerkOrgId(db, auth.orgId);
    if (!account) throw new Error("failed to create account");
  } else {
    // Never re-activate a stored past_due row from the session. Clerk keeps the
    // plan entitlement assigned during the past_due dunning/grace window, so
    // auth.has({plan}) stays true until the subscription transitions to "ended".
    // If we let an active session claim flip a past_due row back to active here,
    // /api/account/sync (hit on every dashboard/billing load) would silently set
    // sendingEnabled:true and let an unpaid org resume sending. Re-activation is
    // deferred to the authoritative subscriptionItem.active webhook, which carries
    // the real lifecycle. We keep the recorded past_due plan/limit so the user
    // still sees the "fix payment" CTA for the plan they owe for.
    const keepPastDue = account.subscriptionStatus === "past_due";
    const effectivePlan: PlanKey = keepPastDue
      ? (isPlanKey(account.plan) ? account.plan : "none")
      : plan;
    const effectiveLifecycle: SubscriptionLifecycle = keepPastDue ? "past_due" : lifecycle;
    await db
      .update(accounts)
      .set({ ...entitlementFields(account, effectivePlan, effectiveLifecycle), updatedAt: now })
      .where(eq(accounts.id, account.id));
    account = (await getAccountByClerkOrgId(db, auth.orgId))!;
  }

  // Record the member locally, reconciling email and the org role on every sync
  // (upsert) so a role change in Clerk is reflected and a concurrent first load
  // does not throw on the unique (account, user) index.
  const user = await clerk.users.getUser(auth.userId);
  const email =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ?? "";
  const membership = await clerk.organizations
    .getOrganizationMembershipList({ organizationId: auth.orgId, userId: [auth.userId], limit: 1 })
    .then((res) => res.data[0])
    .catch(() => undefined);
  await reconcileMembership(db, {
    accountId: account.id,
    clerkUserId: auth.userId,
    email,
    role: roleFromClerk(membership?.role),
  });

  return account;
}

// Webhook-driven entitlement update (subscriptionItem.* events). The lifecycle
// maps deterministically to subscriptionStatus + sendingEnabled via
// entitlementsFor; the plan slug maps to monthlyEmailLimit via planFromSlug. This
// is idempotent: applying the same event twice converges on the same row, and
// out-of-order delivery is tolerated (the only order-sensitive effect — zeroing
// usage on a new period — is guarded by the period-start boundary below).
export async function applySubscriptionEvent(
  db: Db,
  input: {
    clerkOrgId: string;
    planSlug: string | undefined;
    lifecycle: SubscriptionLifecycle;
    periodStart?: string | null;
    periodEnd?: string | null;
  },
): Promise<void> {
  const account = await getAccountByClerkOrgId(db, input.clerkOrgId);
  if (!account) return; // Account is created lazily on first dashboard load.

  // An "ended" subscription drops to the no-plan tier (limit 0). active/past_due
  // keep the plan from the event's slug (falling back to the recorded plan when
  // the slug is absent on a pastDue/ended payload) so a past_due account still
  // shows the plan it owes for.
  const recordedPlan: PlanKey = isPlanKey(account.plan) ? account.plan : "none";
  const plan: PlanKey =
    input.lifecycle === "ended"
      ? "none"
      : input.planSlug
        ? planFromSlug(input.planSlug)
        : recordedPlan;

  // This webhook is the primary period source: when Clerk reports a period
  // start later than the one we have, a new billing period has begun, so we zero
  // usage here. The monthly cron is only a fallback for accounts that never get
  // this event. Guarding on the start boundary keeps a redelivered webhook (or a
  // webhook racing the cron on the 1st) from resetting the same period twice.
  // Compare as instants, not strings: Postgres surfaces the stored timestamptz
  // in its own textual format ("2026-06-01 00:00:00+00"), which does not order
  // lexically against an ISO-8601 input.
  // Only an active event starts a fresh billing period; a pastDue/ended event
  // carries the same period and must never zero usage.
  const periodAdvanced =
    input.lifecycle === "active" &&
    !!input.periodStart &&
    (!account.currentPeriodStart ||
      Date.parse(input.periodStart) > Date.parse(account.currentPeriodStart));

  await db
    .update(accounts)
    .set({
      ...entitlementFields(account, plan, input.lifecycle),
      currentPeriodStart: input.periodStart ?? account.currentPeriodStart,
      currentPeriodEnd: input.periodEnd ?? account.currentPeriodEnd,
      ...(periodAdvanced ? { monthlyEmailSentCount: 0 } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(accounts.id, account.id));
}
