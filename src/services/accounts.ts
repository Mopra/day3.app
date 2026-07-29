import { and, eq } from "drizzle-orm";
import type { ClerkClient } from "@clerk/backend";
import type { Db } from "../db/client";
import { accountUsers, accounts, type Account } from "../db/schema";
import type { JobQueue } from "../queue/messages";
import { newId, nowIso } from "../lib/ids";
import {
  FREE_PLAN,
  entitlementsFor,
  isPlanKey,
  isUnknownPlanSlug,
  planFromEntitlements,
  planFromSlug,
  planOverrideFromMetadata,
  type PlanKey,
  type SubscriptionLifecycle,
} from "./plans";

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

// Locally-recorded member count for an account. Used to detect a memberless org.
export async function countAccountMembers(db: Db, accountId: string): Promise<number> {
  const rows = await db
    .select({ id: accountUsers.id })
    .from(accountUsers)
    .where(eq(accountUsers.accountId, accountId));
  return rows.length;
}

// Removes one member and, if it was the org's last, enqueues a full account purge.
// A memberless org is unreachable — no one can ever sign in to it again — so we
// treat "last member gone" as a deletion and erase all its data. Shared by the
// organizationMembership.deleted and user.deleted webhook paths; enqueuing is
// idempotent (the purge handler no-ops on an already-gone account), so a duplicate
// or racing event is harmless.
export async function removeMembershipAndMaybePurge(
  db: Db,
  queue: JobQueue,
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
  if ((await countAccountMembers(db, account.id)) === 0) {
    await queue.send({ type: "purge_account", accountId: account.id });
  }
}

// A Clerk user deleted their own account (user.deleted webhook). Strips their PII
// (their account_users rows) from every org they belonged to; any org left with no
// members is purged entirely. We reconcile from our own roster rather than trusting
// event ordering — Clerk also fires organizationMembership.deleted per org, but this
// converges regardless of which arrives first (both call the same purge, and the
// purge is idempotent).
export async function handleUserDeleted(
  db: Db,
  queue: JobQueue,
  clerkUserId: string,
): Promise<void> {
  const memberships = await db
    .select({ accountId: accountUsers.accountId })
    .from(accountUsers)
    .where(eq(accountUsers.clerkUserId, clerkUserId));
  const accountIds = [...new Set(memberships.map((m) => m.accountId))];
  for (const accountId of accountIds) {
    await db
      .delete(accountUsers)
      .where(
        and(eq(accountUsers.accountId, accountId), eq(accountUsers.clerkUserId, clerkUserId)),
      );
    if ((await countAccountMembers(db, accountId)) === 0) {
      await queue.send({ type: "purge_account", accountId });
    }
  }
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
  // The active session's role for the active org (Clerk's `auth().orgRole`, e.g.
  // "org:admin"). Read from the session JWT — no Clerk API round-trip — so the
  // per-member role reconcile below doesn't need getOrganizationMembershipList.
  orgRole?: string | null;
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

  // Fetch the org up front: we need its name (when creating the row) and its
  // publicMetadata, which may carry a manual tier override for testers.
  const org = await clerk.organizations.getOrganization({ organizationId: auth.orgId });

  // A tester override in the org's publicMetadata (e.g. { "plan": "25k_plan" })
  // forces that tier regardless of real billing. Otherwise the session's billing
  // claim tells us which paid tier (if any) the org holds; with no paid grant the
  // org sits on the always-active free tier. A past_due subscription is carried by
  // the webhook (which has the lifecycle); we never downgrade an active row to
  // past_due from the session — only the webhook does (handled below). The
  // override, when present, also bypasses the past_due hold so a tester always
  // lands on the chosen tier.
  const overridePlan = planOverrideFromMetadata(org.publicMetadata);
  const plan: PlanKey =
    overridePlan ?? (auth.has ? planFromEntitlements(auth.has) : FREE_PLAN);
  const lifecycle: SubscriptionLifecycle = "active";
  if (overridePlan) {
    console.info(`[tier-override] org ${auth.orgId} forced to ${overridePlan} via publicMetadata`);
  }

  let account = await getAccountByClerkOrgId(db, auth.orgId);
  const now = nowIso();

  if (!account) {
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
    // A tester override forces its tier active, bypassing the past_due hold.
    const keepPastDue = !overridePlan && account.subscriptionStatus === "past_due";
    const effectivePlan: PlanKey = keepPastDue
      ? (isPlanKey(account.plan) ? account.plan : FREE_PLAN)
      : plan; // `plan` already prefers the override

    // The session claim resolving to Free for an org we have recorded on a paid
    // tier is the fingerprint of a Clerk/catalog slug mismatch: `has()` is a
    // predicate, so a tier whose slug we spell differently simply never matches
    // and the org reads as unsubscribed. It can also be a genuine cancellation
    // whose `subscriptionItem.ended` webhook we missed, or a session token that
    // predates a fresh subscription — all three are worth knowing about, and all
    // three are invisible without this.
    if (!overridePlan && !keepPastDue && effectivePlan === FREE_PLAN && isPlanKey(account.plan) && account.plan !== FREE_PLAN) {
      console.error(
        `[plans] org ${auth.orgId} is recorded on "${account.plan}" but its session billing ` +
          `claims resolve to "${FREE_PLAN}" — downgrading. If this org is paying, the Clerk ` +
          `plan slug does not match the catalog key in src/lib/plans-catalog.ts.`,
      );
    }
    const effectiveLifecycle: SubscriptionLifecycle = keepPastDue ? "past_due" : lifecycle;
    await db
      .update(accounts)
      .set({ ...entitlementFields(account, effectivePlan, effectiveLifecycle), updatedAt: now })
      .where(eq(accounts.id, account.id));
    account = (await getAccountByClerkOrgId(db, auth.orgId))!;
  }

  // Record the member locally, reconciling email and the org role on every sync
  // (upsert) so a role change in Clerk is reflected and a concurrent first load
  // does not throw on the unique (account, user) index. The role comes from the
  // session claim (auth.orgRole) rather than a getOrganizationMembershipList API
  // call — the active session already carries the current user's role for the
  // active org. Role changes for *other* members are reconciled by the
  // organizationMembership.* webhook.
  const user = await clerk.users.getUser(auth.userId);
  const email =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId)?.emailAddress ?? "";
  await reconcileMembership(db, {
    accountId: account.id,
    clerkUserId: auth.userId,
    email,
    role: roleFromClerk(auth.orgRole),
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

  // An "ended" subscription gracefully downgrades to the always-active free tier
  // (the org keeps all features and a small send allowance instead of being
  // locked out). active/past_due keep the plan from the event's slug (falling
  // back to the recorded plan when the slug is absent on a pastDue/ended payload)
  // so a past_due account still shows the plan it owes for.
  const ended = input.lifecycle === "ended";
  const recordedPlan: PlanKey = isPlanKey(account.plan) ? account.plan : FREE_PLAN;
  // A slug we don't recognize means the Clerk dashboard and the catalog disagree
  // (a typo'd or renamed plan), NOT that the org stopped paying. Treat it exactly
  // like an absent slug — keep the recorded plan — because resolving it to Free
  // here would strip sending from an org that is paying us. Loud, because nothing
  // else in the system will notice.
  if (isUnknownPlanSlug(input.planSlug)) {
    console.error(
      `[plans] unknown Clerk plan slug "${input.planSlug}" for org ${input.clerkOrgId} — ` +
        `keeping recorded plan "${recordedPlan}". The slug must match a key in ` +
        `src/lib/plans-catalog.ts; fix the plan slug in the Clerk dashboard.`,
    );
  }
  const slugPlan: PlanKey | null =
    input.planSlug && !isUnknownPlanSlug(input.planSlug) ? planFromSlug(input.planSlug) : null;
  const plan: PlanKey = ended ? FREE_PLAN : (slugPlan ?? recordedPlan);
  // Reverting to the free tier means the account is active again (nothing to pay),
  // not "inactive". Only active/past_due lifecycles pass through unchanged.
  const lifecycle: SubscriptionLifecycle = ended ? "active" : input.lifecycle;

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
      ...entitlementFields(account, plan, lifecycle),
      currentPeriodStart: input.periodStart ?? account.currentPeriodStart,
      currentPeriodEnd: input.periodEnd ?? account.currentPeriodEnd,
      ...(periodAdvanced ? { monthlyEmailSentCount: 0 } : {}),
      updatedAt: nowIso(),
    })
    .where(eq(accounts.id, account.id));
}
